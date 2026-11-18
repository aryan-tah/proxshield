/**
 * Configuration: an optional TOML file, with `PROXSHIELD_*` environment variables on top.
 * Every setting has a safe default, so proxshield runs with no file at all.
 */
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";

export type Action = "allow" | "redact" | "mask" | "block";
/** allow: leave it. redact: placeholder, restored in the response. mask: placeholder, never restored. block: reject the request. */
export const ACTIONS: readonly Action[] = ["allow", "redact", "mask", "block"];

export const DEFAULT_ENTITIES: Readonly<Record<string, Action>> = {
  EMAIL: "redact",
  PHONE: "redact",
  CREDIT_CARD: "redact",
  US_SSN: "redact",
  IBAN: "redact",
  IP_ADDRESS: "redact",
  PERSON: "redact",
  LOCATION: "allow",
  ORGANIZATION: "allow",
  SECRET: "mask",
  // Only found by OpenAI Privacy Filter (`pii.model = "privacy-filter"`).
  ADDRESS: "redact",
  ACCOUNT_NUMBER: "redact",
  DATE: "allow",
  URL: "allow",
};

export type InjectionModelName = "prompt-guard-2" | "protectai";
export const INJECTION_MODEL_NAMES: readonly InjectionModelName[] = ["prompt-guard-2", "protectai"];

export type PiiModel = "bert" | "privacy-filter" | "none";
export const PII_MODELS: readonly PiiModel[] = ["bert", "privacy-filter", "none"];

export interface CustomPattern {
  name: string;
  pattern: RegExp;
  action: Action;
}

export interface Config {
  /** Action per entity type. */
  entities: Record<string, Action>;
  custom: CustomPattern[];
  /** `bert` (110 MB: names, places, organizations), `privacy-filter` (OpenAI Privacy Filter, 0.9 GB: also addresses, dates, account numbers) or `none` (patterns only). */
  piiModel: PiiModel;
  piiThreshold: number;
  /** Region for phone numbers written without a country code. */
  phoneRegion: string;
  /** What to do with personal data in a reply that wasn't in the request: `allow` or `mask`. */
  outputPii: Action;

  injection: boolean;
  /** `prompt-guard-2` (Meta, 22M, default) or `protectai` (the DeBERTa model LLM Guard used). */
  injectionModel: InjectionModelName;
  injectionThreshold: number;
  /** Message roles scanned for injection. `tool` covers tool results and retrieved documents. */
  injectionRoles: Set<string>;
  /** `block` rejects the request; `allow` only reports it. */
  injectionAction: Action;
  /** Long texts from these roles are also scored a few sentences at a time. */
  injectionChunkRoles: Set<string>;
  /** Size of those chunks, in characters. 0 turns chunking off. */
  injectionChunkChars: number;

  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  /** Keep the provider key on the server. Clients then authenticate with a proxshield key. */
  openaiApiKey?: string | undefined;
  anthropicApiKey?: string | undefined;
  upstreamTimeoutMs: number;
  /** `error` returns the provider's error format; `refusal` returns a normal reply saying no. */
  blockMode: "error" | "refusal";
  refusalMessage: string;

  /** Keys clients use for proxshield itself. Empty means no key is required. */
  apiKeys: Set<string>;
  /** `models` (real models) or `fake` (keyword matching, for tests). */
  backend: "models" | "fake";
  /** Where models are downloaded. */
  cacheDir?: string | undefined;
  preload: boolean;
  maxBodyBytes: number;
}

export function defaultConfig(overrides: Partial<Config> = {}): Config {
  return {
    entities: { ...DEFAULT_ENTITIES },
    custom: [],
    piiModel: "bert",
    piiThreshold: 0.8,
    phoneRegion: "US",
    outputPii: "mask",
    injection: true,
    injectionModel: "prompt-guard-2",
    injectionThreshold: 0.9,
    injectionRoles: new Set(["user", "tool"]),
    injectionAction: "block",
    injectionChunkRoles: new Set(["tool"]),
    injectionChunkChars: 150,
    openaiBaseUrl: "https://api.openai.com/v1",
    anthropicBaseUrl: "https://api.anthropic.com",
    upstreamTimeoutMs: 600_000,
    blockMode: "error",
    refusalMessage: "I can't help with that request.",
    apiKeys: new Set(),
    backend: "models",
    preload: true,
    maxBodyBytes: 4 * 1024 * 1024,
    ...overrides,
  };
}

export function actionFor(config: Config, entity: string): Action {
  const custom = config.custom.find((c) => c.name === entity);
  return custom ? custom.action : (config.entities[entity] ?? "allow");
}

const ENTITY_NAME = /^[A-Z][A-Z0-9_]{0,31}$/;

function action(value: unknown, where: string): Action {
  const v = String(value).toLowerCase();
  if (!(ACTIONS as readonly string[]).includes(v)) {
    throw new Error(`${where}: ${JSON.stringify(value)} is not one of ${ACTIONS.join(", ")}`);
  }
  return v as Action;
}

function injectionModel(value: unknown): InjectionModelName {
  if (!(INJECTION_MODEL_NAMES as readonly unknown[]).includes(value)) {
    throw new Error(
      `injection.model: ${JSON.stringify(value)} is not one of ${INJECTION_MODEL_NAMES.join(", ")}`,
    );
  }
  return value as InjectionModelName;
}

function piiModel(value: unknown): PiiModel {
  if (!(PII_MODELS as readonly unknown[]).includes(value)) {
    throw new Error(`pii.model: ${JSON.stringify(value)} is not one of ${PII_MODELS.join(", ")}`);
  }
  return value as PiiModel;
}

type Table = Record<string, unknown>;
const table = (v: unknown): Table => (v && typeof v === "object" && !Array.isArray(v) ? (v as Table) : {});
const trimSlash = (s: string) => s.replace(/\/+$/, "");

export function fromToml(data: Table, base: Config = defaultConfig()): Config {
  const cfg: Config = { ...base, entities: { ...base.entities }, custom: [...base.custom] };
  const pii = table(data.pii);
  for (const [name, value] of Object.entries(table(pii.entities))) {
    if (!ENTITY_NAME.test(name))
      throw new Error(`pii.entities: ${JSON.stringify(name)} must be UPPER_SNAKE_CASE`);
    cfg.entities[name] = action(value, `pii.entities.${name}`);
  }
  const custom = Array.isArray(pii.custom) ? pii.custom : [];
  custom.forEach((raw, i) => {
    const item = table(raw);
    const name = String(item.name ?? "");
    if (!ENTITY_NAME.test(name)) {
      throw new Error(`pii.custom[${i}].name: ${JSON.stringify(name)} must be UPPER_SNAKE_CASE`);
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(String(item.pattern ?? ""), "g");
      if (item.pattern === undefined) throw new Error("missing");
    } catch (e) {
      throw new Error(`pii.custom[${i}].pattern: ${(e as Error).message}`);
    }
    cfg.custom.push({ name, pattern, action: action(item.action ?? "redact", `pii.custom[${i}]`) });
  });
  if (pii.model !== undefined) cfg.piiModel = piiModel(pii.model);
  if (pii.threshold !== undefined) cfg.piiThreshold = Number(pii.threshold);
  if (pii.phone_region !== undefined) cfg.phoneRegion = String(pii.phone_region).toUpperCase();

  const output = table(data.output);
  if (output.pii !== undefined) {
    const a = action(output.pii, "output.pii");
    if (a !== "allow" && a !== "mask") throw new Error("output.pii must be 'allow' or 'mask'");
    cfg.outputPii = a;
  }

  const inj = table(data.injection);
  if (inj.enabled !== undefined) cfg.injection = Boolean(inj.enabled);
  if (inj.model !== undefined) cfg.injectionModel = injectionModel(inj.model);
  if (inj.threshold !== undefined) cfg.injectionThreshold = Number(inj.threshold);
  if (Array.isArray(inj.roles)) cfg.injectionRoles = new Set(inj.roles.map(String));
  if (inj.action !== undefined) cfg.injectionAction = action(inj.action, "injection.action");
  if (inj.chunk_chars !== undefined) cfg.injectionChunkChars = Number(inj.chunk_chars);
  if (Array.isArray(inj.chunk_roles)) cfg.injectionChunkRoles = new Set(inj.chunk_roles.map(String));

  const up = table(data.upstream);
  if (up.openai_base_url !== undefined) cfg.openaiBaseUrl = trimSlash(String(up.openai_base_url));
  if (up.anthropic_base_url !== undefined) cfg.anthropicBaseUrl = trimSlash(String(up.anthropic_base_url));
  if (up.timeout_seconds !== undefined) cfg.upstreamTimeoutMs = Number(up.timeout_seconds) * 1000;

  const srv = table(data.server);
  if (srv.block_mode !== undefined) {
    if (srv.block_mode !== "error" && srv.block_mode !== "refusal") {
      throw new Error("server.block_mode must be 'error' or 'refusal'");
    }
    cfg.blockMode = srv.block_mode;
  }
  if (srv.refusal_message !== undefined) cfg.refusalMessage = String(srv.refusal_message);
  if (srv.max_body_bytes !== undefined) cfg.maxBodyBytes = Number(srv.max_body_bytes);
  return cfg;
}

const keys = (raw: string) =>
  new Set(
    raw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
const truthy = (raw: string) => !["0", "false", "no", "off", ""].includes(raw.trim().toLowerCase());

/** Read the TOML file (if any), then apply `PROXSHIELD_*` environment variables. */
export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): Config {
  const file = path ?? env.PROXSHIELD_CONFIG;
  let cfg = defaultConfig();
  if (file) cfg = fromToml(parse(readFileSync(file, "utf8")) as Table, cfg);
  if (env.PROXSHIELD_API_KEYS !== undefined) cfg.apiKeys = keys(env.PROXSHIELD_API_KEYS);
  if (env.PROXSHIELD_OPENAI_BASE_URL) cfg.openaiBaseUrl = trimSlash(env.PROXSHIELD_OPENAI_BASE_URL);
  if (env.PROXSHIELD_ANTHROPIC_BASE_URL) cfg.anthropicBaseUrl = trimSlash(env.PROXSHIELD_ANTHROPIC_BASE_URL);
  if (env.PROXSHIELD_OPENAI_API_KEY) cfg.openaiApiKey = env.PROXSHIELD_OPENAI_API_KEY;
  if (env.PROXSHIELD_ANTHROPIC_API_KEY) cfg.anthropicApiKey = env.PROXSHIELD_ANTHROPIC_API_KEY;
  if (env.PROXSHIELD_BACKEND === "fake" || env.PROXSHIELD_BACKEND === "models")
    cfg.backend = env.PROXSHIELD_BACKEND;
  if (env.PROXSHIELD_PII_MODEL) cfg.piiModel = piiModel(env.PROXSHIELD_PII_MODEL);
  if (env.PROXSHIELD_INJECTION_MODEL) cfg.injectionModel = injectionModel(env.PROXSHIELD_INJECTION_MODEL);
  if (env.PROXSHIELD_PRELOAD !== undefined) cfg.preload = truthy(env.PROXSHIELD_PRELOAD);
  if (env.PROXSHIELD_INJECTION_THRESHOLD) cfg.injectionThreshold = Number(env.PROXSHIELD_INJECTION_THRESHOLD);
  if (env.PROXSHIELD_BLOCK_MODE === "error" || env.PROXSHIELD_BLOCK_MODE === "refusal") {
    cfg.blockMode = env.PROXSHIELD_BLOCK_MODE;
  }
  if (env.PROXSHIELD_CACHE_DIR) cfg.cacheDir = env.PROXSHIELD_CACHE_DIR;
  return cfg;
}
