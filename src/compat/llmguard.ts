/**
 * LLM Guard API compatible endpoints: `/analyze/prompt`, `/scan/prompt`, `/analyze/output` and
 * `/scan/output`. LLM Guard (protectai/llm-guard) was archived in July 2026. These routes accept
 * its API's requests and return its response shapes, so its clients can switch by URL.
 */
import type { Context, Hono } from "hono";
import { actionFor } from "../config.js";
import type { Finding } from "../detectors/base.js";
import { TAGS, ZERO_WIDTH } from "../detectors/heuristics.js";
import { bearer, type Deps, keyOk, readJson, requestLog } from "../proxy/common.js";
import { riskScore } from "./scores.js";

/** LLM Guard (Presidio) entity names. */
const NAMES: Record<string, string> = {
  EMAIL: "EMAIL_ADDRESS",
  PHONE: "PHONE_NUMBER",
  IBAN: "IBAN_CODE",
  ADDRESS: "LOCATION",
};
const ANONYMIZE_THRESHOLD = 0.5;

function redact(text: string, findings: Finding[]): string {
  const counters = new Map<string, number>();
  const seen = new Map<string, string>();
  let out = "";
  let last = 0;
  for (const f of findings) {
    out += text.slice(last, f.start);
    if (f.entity === "SECRET") {
      out += "******";
    } else {
      const key = `${f.entity}\u0000${f.text}`;
      let token = seen.get(key);
      if (!token) {
        const name = NAMES[f.entity] ?? f.entity;
        const n = (counters.get(name) ?? 0) + 1;
        counters.set(name, n);
        token = `[REDACTED_${name}_${n}]`;
        seen.set(key, token);
      }
      out += token;
    }
    last = f.end;
  }
  return out + text.slice(last);
}

export async function run(
  deps: Deps,
  text: string,
  prompt: boolean,
  suppress: Set<string>,
): Promise<{ sanitized: string; valid: boolean; scanners: Record<string, number> }> {
  const cfg = deps.config;
  const [all = []] = await deps.guard.detect([text]);
  const found = all.filter((f) => actionFor(cfg, f.entity) !== "allow");
  const secrets = found.filter((f) => f.entity === "SECRET");
  const personal = found.filter((f) => f.entity !== "SECRET");
  const scanners: Record<string, number> = {};
  let valid = true;
  const piiScanner = prompt ? "Anonymize" : "Sensitive";
  if (!suppress.has(piiScanner)) {
    const top = Math.max(0, ...personal.map((f) => f.score));
    scanners[piiScanner] = personal.length ? riskScore(top, ANONYMIZE_THRESHOLD) : -1;
    valid &&= personal.length === 0;
  }
  if (!suppress.has("Secrets")) {
    scanners.Secrets = secrets.length ? 1 : -1;
    valid &&= secrets.length === 0;
  }
  if (prompt && !suppress.has("InvisibleText")) {
    const hidden = new RegExp(TAGS.source, "u").test(text) || new RegExp(ZERO_WIDTH.source).test(text);
    scanners.InvisibleText = hidden ? 1 : -1;
    valid &&= !hidden;
  }
  if (prompt && !suppress.has("PromptInjection") && cfg.injection) {
    const [r] = await deps.guard.injection([text]);
    const score = r?.score ?? 0;
    scanners.PromptInjection = riskScore(score, cfg.injectionThreshold);
    valid &&= score < cfg.injectionThreshold;
  }
  const redacted = found.filter((f) =>
    f.entity === "SECRET" ? !suppress.has("Secrets") : !suppress.has(piiScanner),
  );
  return { sanitized: redact(text, redacted), valid, scanners };
}

async function handle(deps: Deps, c: Context, prompt: boolean, sanitize: boolean): Promise<Response> {
  const log = requestLog(deps, `llmguard.${sanitize ? "analyze" : "scan"}.${prompt ? "prompt" : "output"}`);
  if (!keyOk(deps.config, [bearer(c), c.req.header("x-proxshield-key")])) {
    log("unauthorized", null, 401);
    return c.json({ message: "Invalid API key" }, 401);
  }
  const body = await readJson(c, deps.config);
  const field = prompt ? "prompt" : "output";
  if (body === null || typeof body[field] !== "string" || (!prompt && typeof body.prompt !== "string")) {
    return c.json({ message: "Validation failed", details: [`'${field}' must be a string`] }, 422);
  }
  const suppress = new Set((Array.isArray(body.scanners_suppress) ? body.scanners_suppress : []).map(String));
  const { sanitized, valid, scanners } = await run(deps, String(body[field]), prompt, suppress);
  log(valid ? "valid" : "invalid", null, 200);
  const out: Record<string, unknown> = { is_valid: valid, scanners };
  if (sanitize) out[`sanitized_${field}`] = sanitized;
  return c.json(out);
}

export function llmGuardRoutes(app: Hono, deps: Deps): void {
  app.post("/analyze/prompt", (c) => handle(deps, c, true, true));
  app.post("/scan/prompt", (c) => handle(deps, c, true, false));
  app.post("/analyze/output", (c) => handle(deps, c, false, true));
  app.post("/scan/output", (c) => handle(deps, c, false, false));
}
