/** The engine: find personal data and injection in a set of messages, decide, and redact. */
import { type Action, actionFor, type Config } from "./config.js";
import { type Finding, resolveOverlaps } from "./detectors/base.js";
import { check } from "./detectors/heuristics.js";
import {
  bertNer,
  FakeInjection,
  FakePii,
  type InjectionModel,
  type ModelOptions,
  NoPii,
  type PiiModel,
  privacyFilter,
  TransformersInjection,
} from "./detectors/models.js";
import { findPatterns } from "./detectors/patterns.js";
import { findSecrets } from "./detectors/secrets.js";
import { Vault } from "./vault.js";

/**
 * One piece of text from a request, with the role it came from. Roles: `system`, `user`,
 * `assistant`, `tool` (tool results, retrieved documents) and `tool_args` (arguments of tool
 * calls the model made earlier in the conversation).
 */
export interface Segment {
  role: string;
  text: string;
}

export interface InjectionResult {
  segment: number;
  score: number;
  reasons: string[];
  modelScore: number | null;
}

export interface Inspection {
  /** Segment texts after redaction, in the same order as the input. */
  texts: string[];
  findings: Finding[][];
  injections: InjectionResult[];
  /** Why the request was blocked, or null. */
  blocked: string | null;
}

export function counts(config: Config, inspection: Inspection): Record<string, number> {
  const c: Record<string, number> = {};
  for (const found of inspection.findings) {
    for (const f of found) {
      if (actionFor(config, f.entity) !== "allow") c[f.entity] = (c[f.entity] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(c).sort(([a], [b]) => a.localeCompare(b)));
}

export function injectionScore(inspection: Inspection): number {
  return Math.max(0, ...inspection.injections.map((r) => r.score));
}

export class Guard {
  constructor(
    readonly config: Config,
    readonly injectionModel: InjectionModel,
    readonly piiModel: PiiModel,
  ) {}

  /** Load the models and run one tiny request through them, so the first real one isn't slow. */
  async warmup(): Promise<void> {
    await Promise.all([this.injectionModel.load(), this.piiModel.load()]);
    await this.inspect(
      [{ role: "user", text: "Warm up: email jane@example.com about the meeting." }],
      new Vault(),
    );
  }

  async detect(texts: string[]): Promise<Finding[][]> {
    const cfg = this.config;
    const fromModel: Finding[][] = texts.map(() => []);
    const todo = texts.map((t, i) => (t.trim() ? i : -1)).filter((i) => i >= 0);
    if (todo.length) {
      const found = await this.piiModel.find(
        todo.map((i) => texts[i] ?? ""),
        cfg.piiThreshold,
      );
      todo.forEach((i, j) => {
        fromModel[i] = found[j] ?? [];
      });
    }
    return texts.map((text, i) => {
      const found: Finding[] = [...findPatterns(text, cfg.phoneRegion), ...findSecrets(text)];
      for (const c of cfg.custom) {
        for (const m of text.matchAll(c.pattern)) {
          found.push({
            entity: c.name,
            start: m.index,
            end: m.index + m[0].length,
            text: m[0],
            score: 1,
            detector: "custom",
          });
        }
      }
      found.push(...(fromModel[i] ?? []));
      return resolveOverlaps(found.filter((f) => f.end > f.start));
    });
  }

  /**
   * Score each text for prompt injection: the higher of the heuristics and the model. Long texts
   * are also scored a few sentences at a time, so one injected sentence inside a long, ordinary
   * document (a poisoned tool result) isn't drowned out by the text around it.
   */
  async injection(
    texts: string[],
    roles?: string[],
  ): Promise<{ score: number; reasons: string[]; modelScore: number | null }[]> {
    const threshold = this.config.injectionThreshold;
    const results = texts.map(check);
    // Skip the model where the heuristics are already sure.
    const todo = results
      .map((h, i) => (h.score < threshold && texts[i]?.trim() ? i : -1))
      .filter((i) => i >= 0);
    const pieces: { owner: number; text: string }[] = [];
    for (const i of todo) {
      // Hidden text decoded from Unicode tags is scored along with the visible text.
      const hidden = results[i]?.hiddenText;
      const text = (texts[i] ?? "") + (hidden ? `\n${hidden}` : "");
      pieces.push({ owner: i, text });
      const role = roles?.[i] ?? "tool";
      const size = this.config.injectionChunkRoles.has(role) ? this.config.injectionChunkChars : 0;
      for (const chunk of sentenceChunks(text, size)) {
        pieces.push({ owner: i, text: chunk });
      }
    }
    const scores = await this.injectionModel.score(pieces.map((p) => p.text));
    const byIndex = new Map<number, number>();
    pieces.forEach((p, j) => {
      byIndex.set(p.owner, Math.max(byIndex.get(p.owner) ?? 0, scores[j] ?? 0));
    });
    return results.map((h, i) => {
      const m = byIndex.get(i) ?? null;
      const reasons = [...h.reasons];
      if (m !== null && m >= threshold) reasons.push("classifier");
      return { score: Math.max(h.score, m ?? 0), reasons, modelScore: m };
    });
  }

  async inspect(segments: Segment[], vault: Vault): Promise<Inspection> {
    const cfg = this.config;
    const texts = segments.map((s) => s.text);
    for (const t of texts) vault.reserve(t);
    const findings = await this.detect(texts);
    const inspection: Inspection = { texts: [...texts], findings, injections: [], blocked: null };

    const blocked = [
      ...new Set(
        findings
          .flat()
          .filter((f) => actionFor(cfg, f.entity) === "block")
          .map((f) => f.entity),
      ),
    ].sort();
    if (blocked.length) inspection.blocked = `Request contains blocked data: ${blocked.join(", ")}.`;

    if (cfg.injection) {
      const scanned = segments
        .map((s, i) => (cfg.injectionRoles.has(s.role) && s.text.trim() ? i : -1))
        .filter((i) => i >= 0);
      const results = await this.injection(
        scanned.map((i) => texts[i] ?? ""),
        scanned.map((i) => segments[i]?.role ?? "user"),
      );
      scanned.forEach((segment, j) => {
        const r = results[j];
        if (r) inspection.injections.push({ segment, ...r });
      });
      const worst = inspection.injections.reduce<InjectionResult | null>(
        (a, b) => (a === null || b.score > a.score ? b : a),
        null,
      );
      if (
        inspection.blocked === null &&
        cfg.injectionAction === "block" &&
        worst !== null &&
        worst.score >= cfg.injectionThreshold
      ) {
        const where = segments[worst.segment]?.role === "tool" ? "a tool result" : "the prompt";
        inspection.blocked = `Possible prompt injection in ${where} (score ${worst.score.toFixed(2)}).`;
      }
    }

    inspection.texts = texts.map((text, i) => this.apply(text, findings[i] ?? [], vault));
    return inspection;
  }

  private apply(text: string, found: Finding[], vault: Vault, force?: Action): string {
    let out = "";
    let last = 0;
    for (const f of found) {
      const action = force ?? actionFor(this.config, f.entity);
      if (action === "allow") continue;
      out += text.slice(last, f.start) + vault.placeholder(f.entity, f.text, action === "redact");
      last = f.end;
    }
    return out + text.slice(last);
  }

  /**
   * Mask sensitive data in a model's reply that wasn't in the request. Runs before placeholders
   * are restored, so the user's own values (which the model only saw as placeholders) are never
   * caught here.
   */
  async scanOutput(text: string, vault: Vault): Promise<{ text: string; findings: Finding[] }> {
    if (this.config.outputPii === "allow" || !text.trim()) return { text, findings: [] };
    const [found = []] = await this.detect([text]);
    const sensitive = found.filter((f) => actionFor(this.config, f.entity) !== "allow");
    if (!sensitive.length) return { text, findings: [] };
    return { text: this.apply(text, sensitive, vault, "mask"), findings: sensitive };
  }
}

/** Group sentences into chunks of about `size` characters. Short texts get no chunks. */
export function sentenceChunks(text: string, size: number): string[] {
  if (size <= 0 || text.length <= size * 1.5) return [];
  const sentences = text.split(/(?<=[.!?。！？])\s+|\n+/).filter((s) => s.trim());
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > size) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) chunks.push(current);
  return chunks.length > 1 ? chunks : [];
}

export function createGuard(config: Config, opts: ModelOptions = {}): Guard {
  const options = { cacheDir: config.cacheDir, ...opts };
  if (config.backend === "fake") return new Guard(config, new FakeInjection(), new FakePii());
  const pii =
    config.piiModel === "privacy-filter"
      ? privacyFilter(options)
      : config.piiModel === "none"
        ? new NoPii()
        : bertNer(options);
  return new Guard(config, new TransformersInjection(options, config.injectionModel), pii);
}
