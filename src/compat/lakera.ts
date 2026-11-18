/**
 * Lakera Guard compatible screening: `POST /v2/guard`. Switching from Lakera means changing
 * the base URL from https://api.lakera.ai to proxshield's. The policy comes from proxshield's
 * config, not from `project_id`.
 */
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { type Action, actionFor } from "../config.js";
import type { Segment } from "../guard.js";
import { bearer, type Deps, isRecord, keyOk, readJson, requestLog } from "../proxy/common.js";
import { Vault } from "../vault.js";
import { VERSION } from "../version.js";
import { lakeraLevel } from "./scores.js";

const DETECTOR_TYPES: Record<string, string> = {
  EMAIL: "pii/email",
  PHONE: "pii/phone_number",
  CREDIT_CARD: "pii/credit_card",
  US_SSN: "pii/us_social_security_number",
  IBAN: "pii/iban_code",
  IP_ADDRESS: "pii/ip_address",
  PERSON: "pii/name",
  ADDRESS: "pii/address",
  LOCATION: "pii/location",
  ORGANIZATION: "pii/organization",
  ACCOUNT_NUMBER: "pii/account_number",
  DATE: "pii/date",
  URL: "pii/url",
  SECRET: "secret",
};
const ROLES: Record<string, string> = {
  system: "system",
  developer: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
};
const PROJECT = "project-proxshield";
const POLICY = "policy-proxshield-config";

export const detectorType = (entity: string) => DETECTOR_TYPES[entity] ?? `custom/${entity.toLowerCase()}`;

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => isRecord(p) && typeof p.text === "string")
      .map((p) => (p as { text: string }).text)
      .join("\n");
  }
  return "";
}

function entry(kind: string, detected: boolean, result: string, messageId: number) {
  return {
    project_id: PROJECT,
    policy_id: POLICY,
    detector_id: `detector-proxshield-${kind.replaceAll("/", "-")}`,
    detector_type: kind,
    detected,
    result,
    message_id: messageId,
  };
}

export async function screen(deps: Deps, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cfg = deps.config;
  const messages = (Array.isArray(body.messages) ? body.messages : []).filter(isRecord);
  const segments: Segment[] = messages.map((m) => ({
    role: ROLES[String(m.role)] ?? "user",
    text: text(m.content),
  }));
  const inspection = await deps.guard.inspect(segments, new Vault());
  const enforce = cfg.injectionAction === "block";
  const pii = inspection.findings.flatMap((found, i) =>
    found.filter((f) => actionFor(cfg, f.entity) !== "allow").map((f) => ({ i, f })),
  );
  const attack = inspection.injections.some((r) => r.score >= cfg.injectionThreshold);
  const response: Record<string, unknown> = {
    flagged: enforce && (attack || pii.length > 0),
    action: enforce ? "enforce" : "detect",
    metadata: { request_uuid: randomUUID() },
  };
  if (body.payload) {
    response.payload = pii.map(({ i, f }) => ({
      start: f.start,
      end: f.end,
      text: f.text,
      detector_type: detectorType(f.entity),
      labels: [],
      message_id: i,
    }));
  }
  if (body.breakdown) {
    const breakdown = inspection.injections.map((r) =>
      entry("prompt_attack", r.score >= cfg.injectionThreshold, lakeraLevel(r.score), r.segment),
    );
    const policy: Record<string, Action> = { ...cfg.entities };
    for (const c of cfg.custom) policy[c.name] = c.action;
    const sensitive = Object.keys(policy)
      .filter((e) => policy[e] !== "allow")
      .sort();
    segments.forEach((_, i) => {
      const found = new Map((inspection.findings[i] ?? []).map((f) => [f.entity, f.score]));
      for (const entity of sensitive) {
        const score = found.get(entity);
        breakdown.push(
          entry(
            detectorType(entity),
            score !== undefined,
            score !== undefined ? lakeraLevel(score) : "l5_unlikely",
            i,
          ),
        );
      }
    });
    response.breakdown = breakdown;
  }
  if (body.dev_info) {
    response.dev_info = {
      git_revision: "",
      git_timestamp: "",
      model_version: `proxshield-${VERSION}`,
      version: VERSION,
    };
  }
  return response;
}

export function lakeraRoutes(app: Hono, deps: Deps): void {
  app.post("/v2/guard", async (c) => {
    const log = requestLog(deps, "lakera.guard");
    if (!keyOk(deps.config, [bearer(c), c.req.header("x-proxshield-key")])) {
      log("unauthorized", null, 401);
      return c.json({ error: "Invalid API key." }, 401);
    }
    const body = await readJson(c, deps.config);
    if (body === null || !Array.isArray(body.messages)) {
      return c.json({ error: "Request must be a JSON object with a messages array." }, 400);
    }
    const result = await screen(deps, body);
    log(result.flagged ? "flagged" : "clean", null, 200);
    return c.json(result);
  });
}
