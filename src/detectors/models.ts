/**
 * Model backends: real models through transformers.js (ONNX Runtime), and fakes for tests.
 *
 * - Llama Prompt Guard 2 22M (Llama 4 Community License) classifies prompt injection by default;
 *   protectai/deberta-v3-base-prompt-injection-v2 (Apache-2.0) is the alternative.
 * - Xenova/bert-base-NER (MIT, ONNX build of dslim/bert-base-NER) finds people, places, organizations.
 * - openai/privacy-filter (Apache-2.0) finds people, addresses, emails, phones, dates, URLs,
 *   account numbers and secrets.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Finding } from "./base.js";

export interface InjectionModelSpec {
  id: string;
  /** Label of the "this is an attack" class. */
  positive: string;
  dtype: "fp32" | "q8";
  subfolder?: string;
  fileName?: string;
}

export const INJECTION_MODELS = {
  /** Meta's Llama Prompt Guard 2, 22M parameters (ONNX build by gravitee-io). Llama 4 Community License. */
  "prompt-guard-2": {
    id: "gravitee-io/Llama-Prompt-Guard-2-22M-onnx",
    positive: "MALICIOUS",
    dtype: "fp32",
    subfolder: "",
    fileName: "model",
  },
  /** Protect AI's DeBERTa v3 classifier, the model LLM Guard shipped. Apache-2.0. */
  protectai: { id: "protectai/deberta-v3-base-prompt-injection-v2", positive: "INJECTION", dtype: "fp32" },
} satisfies Record<string, InjectionModelSpec>;
export type InjectionModelName = keyof typeof INJECTION_MODELS;
export const INJECTION_MODEL = INJECTION_MODELS["prompt-guard-2"].id;
export const BERT_NER_MODEL = "Xenova/bert-base-NER";
export const PRIVACY_FILTER_MODEL = "openai/privacy-filter";

const NER_LABELS: Record<string, string> = { PER: "PERSON", LOC: "LOCATION", ORG: "ORGANIZATION" };
const PRIVACY_FILTER_LABELS: Record<string, string> = {
  private_person: "PERSON",
  private_address: "ADDRESS",
  private_email: "EMAIL",
  private_phone: "PHONE",
  private_date: "DATE",
  private_url: "URL",
  account_number: "ACCOUNT_NUMBER",
  secret: "SECRET",
};

export interface InjectionModel {
  readonly name: string;
  load(): Promise<void>;
  /** Probability that each text is a prompt injection. */
  score(texts: string[]): Promise<number[]>;
}

export interface PiiModel {
  readonly name: string;
  load(): Promise<void>;
  find(texts: string[], threshold: number): Promise<Finding[][]>;
}

export interface ModelOptions {
  cacheDir?: string | undefined;
  /** Never download: use only what's in the cache (Docker images bake models in). */
  offline?: boolean;
  threads?: number;
}

// transformers.js is large; load it only when a real model is used.
type Transformers = typeof import("@huggingface/transformers");
let transformers: Promise<Transformers> | undefined;
async function lib(opts: ModelOptions): Promise<Transformers> {
  transformers ??= import("@huggingface/transformers");
  const t = await transformers;
  t.env.cacheDir =
    opts.cacheDir ?? process.env.PROXSHIELD_CACHE_DIR ?? join(homedir(), ".cache", "proxshield");
  if (opts.offline ?? process.env.PROXSHIELD_OFFLINE === "1") t.env.allowRemoteModels = false;
  return t;
}

function sessionOptions(opts: ModelOptions): Record<string, unknown> {
  const threads = opts.threads ?? Number(process.env.PROXSHIELD_THREADS ?? 0);
  return threads > 0 ? { session_options: { intraOpNumThreads: threads } } : {};
}

/** Split long text into overlapping windows that break on whitespace. */
export function windows(text: string, size: number, overlap: number): { start: number; text: string }[] {
  if (text.length <= size) return [{ start: 0, text }];
  const out: { start: number; text: string }[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > start + size / 2) end = space;
    }
    out.push({ start, text: text.slice(start, end) });
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

function softmax(row: number[]): number[] {
  const max = Math.max(...row);
  const exps = row.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

// biome-ignore lint/suspicious/noExplicitAny: transformers.js model and tokenizer types are loose
type Any = any;

export class TransformersInjection implements InjectionModel {
  readonly name: string;
  private readonly spec: InjectionModelSpec;
  private loaded?: Promise<{ tokenizer: Any; model: Any; column: number }>;

  constructor(
    private readonly opts: ModelOptions = {},
    model: InjectionModelName = "prompt-guard-2",
  ) {
    this.spec = INJECTION_MODELS[model];
    this.name = this.spec.id;
  }

  private get(): Promise<{ tokenizer: Any; model: Any; column: number }> {
    this.loaded ??= (async () => {
      const t = await lib(this.opts);
      const spec = this.spec;
      const tokenizer = await t.AutoTokenizer.from_pretrained(spec.id);
      const model = await t.AutoModelForSequenceClassification.from_pretrained(spec.id, {
        dtype: spec.dtype,
        ...(spec.subfolder !== undefined ? { subfolder: spec.subfolder } : {}),
        ...(spec.fileName !== undefined ? { model_file_name: spec.fileName } : {}),
        ...sessionOptions(this.opts),
      });
      const id2label = (model.config as unknown as { id2label: Record<string, string> }).id2label;
      const column = Number(
        Object.entries(id2label).find(([, v]) => v.toUpperCase() === spec.positive)?.[0] ?? 1,
      );
      return { tokenizer, model, column };
    })();
    return this.loaded;
  }

  async load(): Promise<void> {
    await this.get();
  }

  /** Long texts are scored in overlapping windows; each text takes its highest window, so an
   * injection buried at the end of a long document still counts. */
  async score(texts: string[]): Promise<number[]> {
    if (texts.length === 0) return [];
    const { tokenizer, model, column } = await this.get();
    const pieces: { owner: number; text: string }[] = [];
    texts.forEach((text, owner) => {
      for (const w of windows(text, 1800, 300)) pieces.push({ owner, text: w.text });
    });
    const best = texts.map(() => 0);
    for (let i = 0; i < pieces.length; i += 8) {
      const batch = pieces.slice(i, i + 8);
      const inputs = tokenizer(
        batch.map((p) => p.text),
        { padding: true, truncation: true, max_length: 512 },
      );
      const { logits } = await model(inputs);
      const rows = logits.tolist() as number[][];
      rows.forEach((row, j) => {
        const piece = batch[j];
        if (!piece) return;
        best[piece.owner] = Math.max(best[piece.owner] ?? 0, softmax(row)[column] ?? 0);
      });
    }
    return best;
  }
}

interface Token {
  label: string;
  score: number;
  start: number | null;
  end: number | null;
}

/** Run a token classifier and line each token up with its characters in the original text. */
async function classifyTokens(tokenizer: Any, model: Any, text: string): Promise<Token[]> {
  const inputs = tokenizer(text, { truncation: true, max_length: 512 });
  const ids = inputs.input_ids.tolist()[0] as (number | bigint)[];
  const { logits } = await model(inputs);
  const rows = logits.tolist()[0] as number[][];
  const id2label = model.config.id2label as Record<string, string>;
  const special = new Set<number>((tokenizer.all_special_ids ?? []).map(Number));
  const tokens: Token[] = [];
  let cursor = 0;
  ids.forEach((rawId, i) => {
    const id = Number(rawId);
    const probs = softmax(rows[i] ?? []);
    let bestIdx = 0;
    for (let j = 1; j < probs.length; j++) if ((probs[j] ?? 0) > (probs[bestIdx] ?? 0)) bestIdx = j;
    const token: Token = {
      label: id2label[bestIdx] ?? "O",
      score: probs[bestIdx] ?? 0,
      start: null,
      end: null,
    };
    if (!special.has(id)) {
      const piece = String(tokenizer.decode([id], { skip_special_tokens: true }))
        .replace(/^##/, "")
        .trim();
      if (piece && !piece.includes("�")) {
        const at = text.indexOf(piece, cursor);
        if (at >= 0 && at - cursor <= 64) {
          token.start = at;
          token.end = at + piece.length;
          cursor = token.end;
        }
      }
    }
    tokens.push(token);
  });
  return tokens;
}

function wordBounds(text: string, start: number, end: number): [number, number] {
  const word = /[\p{L}\p{N}'’-]/u;
  while (start > 0 && word.test(text[start - 1] ?? "")) start--;
  while (end < text.length && word.test(text[end] ?? "")) end++;
  return [start, end];
}

/** Join tagged tokens (B-/I-/E-/S- or B-/I-) of the same category into spans. */
export function joinTokens(
  text: string,
  tokens: Token[],
  labels: Record<string, string>,
  threshold: number,
  detector: string,
  expandToWords: boolean,
): Finding[] {
  const spans: { category: string; start: number; end: number; score: number }[] = [];
  for (const tok of tokens) {
    if (tok.label === "O" || !tok.label.includes("-") || tok.start === null || tok.end === null) continue;
    const dash = tok.label.indexOf("-");
    const tag = tok.label.slice(0, dash);
    const category = tok.label.slice(dash + 1);
    const prev = spans.at(-1);
    const continues = tag === "I" || tag === "E";
    if (prev && prev.category === category && (continues || text.slice(prev.end, tok.start).trim() === "")) {
      prev.end = tok.end;
      prev.score = Math.min(prev.score, tok.score);
    } else {
      spans.push({ category, start: tok.start, end: tok.end, score: tok.score });
    }
  }
  const out: Finding[] = [];
  for (const s of spans) {
    const entity = labels[s.category];
    if (!entity || s.score < threshold) continue;
    const [start, end] = expandToWords ? wordBounds(text, s.start, s.end) : [s.start, s.end];
    out.push({ entity, start, end, text: text.slice(start, end), score: s.score, detector });
  }
  return out;
}

class TokenClassifier implements PiiModel {
  private loaded?: Promise<{ tokenizer: Any; model: Any }>;

  constructor(
    readonly name: string,
    private readonly dtype: string,
    private readonly labels: Record<string, string>,
    private readonly windowSize: number,
    private readonly detector: string,
    private readonly expandToWords: boolean,
    private readonly opts: ModelOptions,
  ) {}

  private get(): Promise<{ tokenizer: Any; model: Any }> {
    this.loaded ??= (async () => {
      const t = await lib(this.opts);
      const tokenizer = await t.AutoTokenizer.from_pretrained(this.name);
      const model = await t.AutoModelForTokenClassification.from_pretrained(this.name, {
        dtype: this.dtype as "q8",
        ...sessionOptions(this.opts),
      });
      return { tokenizer, model };
    })();
    return this.loaded;
  }

  async load(): Promise<void> {
    await this.get();
  }

  async find(texts: string[], threshold: number): Promise<Finding[][]> {
    const { tokenizer, model } = await this.get();
    const out: Finding[][] = [];
    for (const text of texts) {
      const found: Finding[] = [];
      for (const w of windows(text, this.windowSize, 200)) {
        const tokens = await classifyTokens(tokenizer, model, w.text);
        for (const f of joinTokens(
          w.text,
          tokens,
          this.labels,
          threshold,
          this.detector,
          this.expandToWords,
        )) {
          found.push({ ...f, start: f.start + w.start, end: f.end + w.start });
        }
      }
      out.push(found);
    }
    return out;
  }
}

export function bertNer(opts: ModelOptions = {}): PiiModel {
  return new TokenClassifier(BERT_NER_MODEL, "q8", NER_LABELS, 1500, "ner", true, opts);
}

/** OpenAI Privacy Filter: a 1.5B-parameter mixture-of-experts token classifier with 50M active
 * parameters. The 4-bit build is about 0.9 GB. */
export function privacyFilter(opts: ModelOptions = {}): PiiModel {
  return new TokenClassifier(
    PRIVACY_FILTER_MODEL,
    "q4",
    PRIVACY_FILTER_LABELS,
    1500,
    "privacy-filter",
    false,
    opts,
  );
}

/** Keyword matching. Only for tests and demos without model downloads. */
export class FakeInjection implements InjectionModel {
  readonly name = "fake";
  static readonly MARKERS = ["jailbreak", "pwned", "bypass the filter", "secret password"];
  async load(): Promise<void> {}
  async score(texts: string[]): Promise<number[]> {
    return texts.map((t) => (FakeInjection.MARKERS.some((m) => t.toLowerCase().includes(m)) ? 0.99 : 0.01));
  }
}

/** Finds a fixed list of names and places. Only for tests. */
export class FakePii implements PiiModel {
  readonly name = "fake";
  static readonly GROUPS: [string, string[]][] = [
    ["PERSON", ["Alice Johnson", "Bob Smith", "Priya Patel", "John", "Maria Garcia"]],
    ["LOCATION", ["Riverside", "Paris", "Pune"]],
    ["ORGANIZATION", ["Acme Corp"]],
  ];
  async load(): Promise<void> {}
  async find(texts: string[]): Promise<Finding[][]> {
    return texts.map((text) => {
      const found: Finding[] = [];
      for (const [entity, names] of FakePii.GROUPS) {
        for (const name of names) {
          for (const m of text.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
            found.push({
              entity,
              start: m.index,
              end: m.index + name.length,
              text: name,
              score: 0.99,
              detector: "ner",
            });
          }
        }
      }
      return found;
    });
  }
}

export class NoPii implements PiiModel {
  readonly name = "none";
  async load(): Promise<void> {}
  async find(texts: string[]): Promise<Finding[][]> {
    return texts.map(() => []);
  }
}
