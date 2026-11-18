/** Shared proxy plumbing: auth, header forwarding, findings headers, SSE parsing and logging. */
import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { Config } from "../config.js";
import { counts, type Guard, type Inspection, injectionScore } from "../guard.js";

export interface Deps {
  config: Config;
  guard: Guard;
  fetch: typeof fetch;
  log: (line: string) => void;
}

const HOP_BY_HOP = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "accept-encoding",
  "content-encoding",
  "x-proxshield-key",
]);

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function keyOk(config: Config, candidates: (string | null | undefined)[]): boolean {
  if (config.apiKeys.size === 0) return true;
  return candidates.some((c) => c && [...config.apiKeys].some((k) => same(c, k)));
}

export function bearer(c: Context): string | null {
  const auth = c.req.header("authorization") ?? "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
}

export function forwardHeaders(c: Context, drop: string[] = [], set: Record<string, string> = {}): Headers {
  const skip = new Set([...HOP_BY_HOP, ...drop.map((d) => d.toLowerCase())]);
  const headers = new Headers();
  for (const [k, v] of Object.entries(c.req.header())) if (!skip.has(k.toLowerCase())) headers.set(k, v);
  for (const [k, v] of Object.entries(set)) headers.set(k, v);
  headers.set("content-type", "application/json");
  return headers;
}

export function findingsHeaders(config: Config, inspection: Inspection | null): Record<string, string> {
  if (!inspection) return {};
  const out: Record<string, string> = {
    "x-proxshield-injection-score": injectionScore(inspection).toFixed(2),
  };
  const c = Object.entries(counts(config, inspection));
  if (c.length) out["x-proxshield-redacted"] = c.map(([k, v]) => `${k}=${v}`).join(",");
  return out;
}

export function responseHeaders(upstream: Headers, config: Config, inspection: Inspection | null): Headers {
  const headers = new Headers();
  upstream.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
  });
  for (const [k, v] of Object.entries(findingsHeaders(config, inspection))) headers.set(k, v);
  return headers;
}

export async function readJson(c: Context, config: Config): Promise<Record<string, unknown> | null> {
  const raw = await c.req.arrayBuffer();
  if (raw.byteLength > config.maxBodyBytes) return null;
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(raw));
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Yield lines from a streamed response body. */
export async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      yield buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  buf += decoder.decode();
  if (buf) yield buf;
}

export function streamOf(gen: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await gen.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}

/** One log line per request: counts and scores only, never text. */
export function requestLog(deps: Deps, route: string) {
  const started = performance.now();
  return (decision: string, inspection: Inspection | null, status?: number) => {
    const c = inspection ? counts(deps.config, inspection) : {};
    const redacted =
      Object.entries(c)
        .map(([k, v]) => `${k}=${v}`)
        .join(",") || "none";
    const score = inspection ? injectionScore(inspection).toFixed(2) : "0.00";
    const ms = (performance.now() - started).toFixed(0);
    deps.log(
      `${route} decision=${decision} status=${status ?? "-"} redacted=${redacted} injection=${score} ms=${ms}`,
    );
  };
}

export type Slot = { role: string; text: string; put: (value: string) => void };

export function setter(obj: Record<string, unknown> | unknown[], key: string | number): (v: string) => void {
  return (v) => {
    (obj as Record<string | number, unknown>)[key] = v;
  };
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
