// proxshield benchmark: prompt-injection detection and personal-data redaction.
// Usage: npm run bench [-- --no-privacy-filter]
import { writeFileSync } from "node:fs";
import { checkInjectionHeuristics, createGuard, defaultConfig, Vault } from "../dist/index.js";
import { injectionSets } from "./data.mjs";
import { piiCases } from "./pii-cases.mjs";

const withPrivacyFilter = !process.argv.includes("--no-privacy-filter");
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

function confusion(items, flags) {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  items.forEach((item, i) => {
    if (item.label === 1) flags[i] ? tp++ : fn++;
    else flags[i] ? fp++ : tn++;
  });
  return {
    n: items.length,
    tp,
    fp,
    tn,
    fn,
    recall: tp + fn ? tp / (tp + fn) : Number.NaN,
    falsePositiveRate: fp + tn ? fp / (fp + tn) : Number.NaN,
    precision: tp + fp ? tp / (tp + fp) : Number.NaN,
  };
}

async function injectionBench(injectionModel) {
  const config = defaultConfig({ piiModel: "none", injectionModel });
  const guard = createGuard(config);
  await guard.injectionModel.load();
  const sets = await injectionSets();
  const results = [];
  for (const set of sets) {
    const texts = set.items.map((x) => x.text);
    const heuristics = texts.map((t) => checkInjectionHeuristics(t).score);
    const model = await guard.injectionModel.score(texts);
    // The real path: heuristics, the model on the whole text, and the model on sentence chunks.
    const started = performance.now();
    const combined = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      combined.push(
        ...(await guard.injection(
          batch,
          batch.map(() => set.role ?? "user"),
        )),
      );
    }
    const msPerItem = (performance.now() - started) / texts.length;
    const t = config.injectionThreshold;
    results.push({
      classifier: injectionModel,
      name: set.name,
      note: set.note,
      heuristics: confusion(
        set.items,
        heuristics.map((s) => s >= 0.85),
      ),
      model: confusion(
        set.items,
        model.map((s) => s >= t),
      ),
      combined: confusion(
        set.items,
        combined.map((r) => r.score >= t),
      ),
      msPerItem,
    });
  }
  return results;
}

function overlap(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

async function piiBench() {
  const cases = piiCases();
  const configs = [
    ["Patterns only", "none"],
    ["Patterns + BERT NER (default)", "bert"],
    ...(withPrivacyFilter ? [["Patterns + OpenAI Privacy Filter", "privacy-filter"]] : []),
  ];
  const out = [];
  for (const [name, piiModel] of configs) {
    const config = defaultConfig({ piiModel, injection: false });
    const guard = createGuard(config);
    await guard.piiModel.load();
    const perEntity = {};
    let goldTotal = 0,
      leaked = 0,
      falsePositives = 0,
      findingsTotal = 0;
    const times = [];
    for (const c of cases) {
      const started = performance.now();
      const ins = await guard.inspect([{ role: "user", text: c.text }], new Vault());
      times.push(performance.now() - started);
      const redacted = (ins.findings[0] ?? []).filter(
        (f) => (config.entities[f.entity] ?? "allow") !== "allow",
      );
      findingsTotal += redacted.length;
      for (const gold of c.spans) {
        goldTotal++;
        perEntity[gold.entity] ??= { total: 0, caught: 0 };
        const e = perEntity[gold.entity];
        e.total++;
        // Caught: redacting findings cover the whole value, so none of it reaches the model.
        const covered = redacted.reduce((n, f) => n + overlap(f, gold), 0);
        if (covered >= gold.end - gold.start) e.caught++;
        else leaked++;
      }
      for (const f of redacted) if (!c.spans.some((g) => overlap(f, g) > 0)) falsePositives++;
    }
    out.push({
      name,
      cases: cases.length,
      values: goldTotal,
      leaked,
      redactedValues: 1 - leaked / goldTotal,
      falsePositives,
      findings: findingsTotal,
      perEntity: Object.fromEntries(
        Object.entries(perEntity).map(([k, v]) => [k, { ...v, recall: v.caught / v.total }]),
      ),
      p50Ms: quantile(times, 0.5),
      p95Ms: quantile(times, 0.95),
    });
  }
  return out;
}

const injectionModels = process.argv.includes("--injection-only-default")
  ? ["prompt-guard-2"]
  : ["prompt-guard-2", "protectai"];
const injection = [];
for (const m of injectionModels) injection.push(...(await injectionBench(m)));
const skipPii = process.argv.includes("--no-pii");
const pii = skipPii ? [] : await piiBench();
const results = {
  date: new Date().toISOString().slice(0, 10),
  machine: `${process.platform}-${process.arch}, Node ${process.version}, CPU only`,
  injection,
  pii,
};
writeFileSync(new URL("./results.json", import.meta.url), `${JSON.stringify(results, null, 2)}\n`);

console.log("\n## Prompt injection (flagged = blocked at the default threshold of 0.9)\n");
console.log(
  "| Dataset | n | Heuristics alone | Model alone (whole text) | proxshield | False alarms | ms per item |",
);
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const r of injection) {
  const hasPos = r.combined.tp + r.combined.fn > 0;
  const hasNeg = r.combined.fp + r.combined.tn > 0;
  console.log(
    `| ${r.classifier} | ${r.name} | ${r.combined.n} | ${hasPos ? pct(r.heuristics.recall) : "–"} | ${hasPos ? pct(r.model.recall) : "–"} | ${hasPos ? pct(r.combined.recall) : "–"} | ${hasNeg ? pct(r.combined.falsePositiveRate) : "–"} | ${r.msPerItem.toFixed(0)} |`,
  );
}
console.log("\n## Personal data (a value counts as redacted only if none of it reaches the model)\n");
const entities = [...new Set(pii.flatMap((p) => Object.keys(p.perEntity)))].sort();
console.log(`| Setup | Redacted | ${entities.join(" | ")} | False positives | p50 / p95 |`);
console.log(`| --- | --- | ${entities.map(() => "---").join(" | ")} | --- | --- |`);
for (const p of pii) {
  console.log(
    `| ${p.name} | ${pct(p.redactedValues)} | ${entities.map((e) => pct(p.perEntity[e]?.recall)).join(" | ")} | ${p.falsePositives} | ${p.p50Ms.toFixed(1)} / ${p.p95Ms.toFixed(1)} ms |`,
  );
}
