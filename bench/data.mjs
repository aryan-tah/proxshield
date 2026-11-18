// Downloads benchmark datasets through the Hugging Face datasets-server API and caches them in
// bench/data/. Everything is sampled with a fixed seed, so runs are repeatable.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORT_MESSAGES } from "./support.mjs";

const DIR = new URL("./data/", import.meta.url).pathname;

async function rows(dataset, split, limit = Number.POSITIVE_INFINITY, config = "default") {
  const file = join(DIR, `${dataset.replace("/", "__")}.${split}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).slice(0, limit);
  mkdirSync(DIR, { recursive: true });
  const out = [];
  for (let offset = 0; out.length < limit; offset += 100) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${dataset} ${split}: HTTP ${res.status}`);
    const page = (await res.json()).rows.map((r) => r.row);
    out.push(...page);
    if (page.length < 100) break;
  }
  writeFileSync(file, JSON.stringify(out));
  return out.slice(0, limit);
}

/** Mulberry32: a tiny seeded PRNG. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sample(list, n, random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

export async function injectionSets() {
  const random = rng(42);
  const deepsetTest = await rows("deepset/prompt-injections", "test");
  const deepsetTrain = await rows("deepset/prompt-injections", "train");
  const gandalf = await rows("Lakera/gandalf_ignore_instructions", "test");
  const dolly = await rows("databricks/databricks-dolly-15k", "train", 3000);

  const benignPrompts = sample(
    dolly.filter((r) => r.instruction.length > 20),
    400,
    random,
  ).map((r) => ({ text: r.instruction, label: 0 }));

  // Documents (Dolly contexts) with an injection from deepset's training split hidden at a
  // random sentence boundary, against the same kind of documents left clean.
  const contexts = sample(
    dolly.filter((r) => r.context.length > 400),
    200,
    random,
  ).map((r) => r.context);
  const attacks = sample(
    deepsetTrain.filter((r) => r.label === 1),
    100,
    random,
  ).map((r) => r.text);
  const documents = contexts.map((ctx, i) => {
    if (i >= 100) return { text: ctx, label: 0 };
    const sentences = ctx.split(/(?<=\.)\s+/);
    const at = 1 + Math.floor(random() * Math.max(1, sentences.length - 1));
    sentences.splice(at, 0, attacks[i]);
    return { text: sentences.join(" "), label: 1 };
  });

  return [
    {
      name: "deepset/prompt-injections (test)",
      note: "Not in the model's training data. About a third is German; the model was trained on English.",
      items: deepsetTest.map((r) => ({ text: r.text, label: r.label })),
    },
    {
      name: "Lakera/gandalf_ignore_instructions (test)",
      note: "All injections. May overlap the model's training data (it lists 8 unnamed MIT datasets).",
      items: gandalf.map((r) => ({ text: r.text, label: 1 })),
    },
    {
      name: "Dolly instructions (benign)",
      note: "400 ordinary instructions from databricks-dolly-15k. Measures false alarms.",
      items: benignPrompts,
    },
    {
      name: "Customer-support messages (benign)",
      note: "50 ordinary checkout, billing and support requests, including ones that use words like ignore, forget, override and act as.",
      items: SUPPORT_MESSAGES.map((text) => ({ text, label: 0 })),
    },
    {
      name: "Injections hidden in documents",
      note: "200 Dolly reference documents; 100 have a deepset (train) injection inserted mid-document. Mimics a poisoned tool result.",
      items: documents,
      role: "tool",
    },
  ];
}
