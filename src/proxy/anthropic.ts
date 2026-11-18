/**
 * Anthropic-compatible proxy: `POST /v1/messages` and `POST /v1/messages/count_tokens`. Point
 * the Anthropic SDK's `baseURL` (or `ANTHROPIC_BASE_URL`) at proxshield.
 */
import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Inspection } from "../guard.js";
import { jsonStringEscape, StreamRestorer, Vault } from "../vault.js";
import {
  bearer,
  type Deps,
  findingsHeaders,
  forwardHeaders,
  isRecord,
  keyOk,
  lines,
  readJson,
  requestLog,
  responseHeaders,
  type Slot,
  setter,
  streamOf,
} from "./common.js";

type Json = Record<string, unknown>;

function error(message: string, status = 400, type = "invalid_request_error"): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

/** Every string inside a JSON value (tool-use input), as slots. */
function strings(value: unknown, role: string, slots: Slot[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      if (typeof v === "string") slots.push({ role, text: v, put: setter(value, i) });
      else strings(v, role, slots);
    });
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string") slots.push({ role, text: v, put: setter(value, k) });
      else strings(v, role, slots);
    }
  }
}

function blocks(list: unknown[], role: string, slots: Slot[]): void {
  for (const block of list) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      slots.push({ role, text: block.text, put: setter(block, "text") });
    } else if (block.type === "tool_use") {
      strings(block.input, "tool_args", slots);
    } else if (block.type === "tool_result") {
      if (typeof block.content === "string")
        slots.push({ role: "tool", text: block.content, put: setter(block, "content") });
      else if (Array.isArray(block.content)) blocks(block.content, "tool", slots);
    } else if (block.type === "document") {
      const source = block.source;
      if (isRecord(source) && source.type === "text" && typeof source.data === "string") {
        slots.push({ role: "tool", text: source.data, put: setter(source, "data") });
      }
    }
  }
}

export function collect(body: Json): Slot[] {
  const slots: Slot[] = [];
  if (typeof body.system === "string")
    slots.push({ role: "system", text: body.system, put: setter(body, "system") });
  else if (Array.isArray(body.system)) blocks(body.system, "system", slots);
  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(msg)) continue;
    const role = msg.role === "assistant" ? "assistant" : "user";
    if (typeof msg.content === "string") slots.push({ role, text: msg.content, put: setter(msg, "content") });
    else if (Array.isArray(msg.content)) blocks(msg.content, role, slots);
  }
  return slots;
}

async function restoreContent(deps: Deps, vault: Vault, content: unknown[]): Promise<void> {
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      const { text } = await deps.guard.scanOutput(block.text, vault);
      block.text = vault.restore(text);
    } else if (block.type === "tool_use") {
      block.input = vault.restoreJson(block.input);
    }
  }
}

function refusal(deps: Deps, body: Json, inspection: Inspection): Response {
  const usage = { input_tokens: 0, output_tokens: 0 };
  const message = {
    id: `msg_proxshield_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model: String(body.model ?? "proxshield"),
    content: [{ type: "text", text: deps.config.refusalMessage }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };
  const headers = findingsHeaders(deps.config, inspection);
  if (!body.stream) return Response.json(message, { headers });
  const event = (type: string, data: Json) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const events = [
    event("message_start", { message: { ...message, content: [], stop_reason: null } }),
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: deps.config.refusalMessage },
    }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage }),
    event("message_stop", {}),
  ];
  return new Response(events.join(""), { headers: { ...headers, "content-type": "text/event-stream" } });
}

/** Restores placeholders in a Messages API SSE stream. */
export class StreamTransformer {
  private readonly restorers = new Map<number, { kind: string; r: StreamRestorer }>();

  constructor(private readonly vault: Vault) {}

  event(data: Json): Json[] {
    const index = Number(data.index ?? 0);
    if (data.type === "content_block_delta" && isRecord(data.delta)) {
      const delta = data.delta;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        delta.text = this.get(index, "text_delta").feed(delta.text);
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        delta.partial_json = this.get(index, "input_json_delta").feed(delta.partial_json);
      }
    } else if (data.type === "content_block_stop") {
      const held = this.restorers.get(index);
      if (held) {
        this.restorers.delete(index);
        const rest = held.r.finish();
        if (rest) {
          const field = held.kind === "text_delta" ? "text" : "partial_json";
          return [{ type: "content_block_delta", index, delta: { type: held.kind, [field]: rest } }, data];
        }
      }
    }
    return [data];
  }

  private get(index: number, kind: string): StreamRestorer {
    let held = this.restorers.get(index);
    if (!held) {
      const r = new StreamRestorer(this.vault, kind === "input_json_delta" ? jsonStringEscape : undefined);
      held = { kind, r };
      this.restorers.set(index, held);
    }
    return held.r;
  }
}

async function* streamEvents(body: ReadableStream<Uint8Array>, vault: Vault): AsyncGenerator<string> {
  const t = new StreamTransformer(vault);
  let name: string | null = null;
  for await (const line of lines(body)) {
    if (line.startsWith("event:")) {
      name = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith("data:")) {
      if (line.trim()) yield `${line}\n\n`;
      continue;
    }
    let data: Json;
    try {
      data = JSON.parse(line.slice(5).trim()) as Json;
    } catch {
      yield `${name ? `event: ${name}\n` : ""}${line}\n\n`;
      continue;
    }
    for (const out of t.event(data)) {
      yield `event: ${String(out.type ?? name)}\ndata: ${JSON.stringify(out)}\n\n`;
    }
    name = null;
  }
}

async function guarded(
  deps: Deps,
  c: Context,
  route: string,
  path: string,
  restore: boolean,
): Promise<Response> {
  const { config, guard } = deps;
  const log = requestLog(deps, route);
  const serverKey = config.anthropicApiKey;
  const candidates: (string | null | undefined)[] = [c.req.header("x-proxshield-key")];
  if (serverKey) candidates.push(c.req.header("x-api-key"), bearer(c));
  if (!keyOk(config, candidates)) {
    log("unauthorized", null, 401);
    return error("Invalid proxshield key.", 401, "authentication_error");
  }
  const body = await readJson(c, config);
  if (body === null) return error("Request body must be a JSON object under the size limit.");

  const vault = new Vault();
  const slots = collect(body);
  const inspection = await guard.inspect(slots, vault);
  if (inspection.blocked) {
    log("blocked", inspection, 400);
    if (config.blockMode === "refusal" && restore) return refusal(deps, body, inspection);
    const res = error(inspection.blocked);
    for (const [k, v] of Object.entries(findingsHeaders(config, inspection))) res.headers.set(k, v);
    return res;
  }
  slots.forEach((s, i) => {
    s.put(inspection.texts[i] ?? s.text);
  });

  const url = new URL(`${config.anthropicBaseUrl}${path}`);
  url.search = new URL(c.req.url).search;
  let upstream: Response;
  try {
    upstream = await deps.fetch(url, {
      method: "POST",
      headers: forwardHeaders(
        c,
        serverKey ? ["x-api-key", "authorization"] : [],
        serverKey ? { "x-api-key": serverKey } : {},
      ),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
  } catch (e) {
    log("upstream_error", inspection, 502);
    return error(`Upstream request failed: ${(e as Error).name}.`, 502, "api_error");
  }

  const headers = responseHeaders(upstream.headers, config, inspection);
  const isSse = (upstream.headers.get("content-type") ?? "").startsWith("text/event-stream");
  if (upstream.status >= 400 || !isSse || !upstream.body) {
    const raw = await upstream.text();
    log("forwarded", inspection, upstream.status);
    if (upstream.status >= 400 || !restore || !raw)
      return new Response(raw, { status: upstream.status, headers });
    let data: Json;
    try {
      data = JSON.parse(raw) as Json;
    } catch {
      return new Response(raw, { status: upstream.status, headers });
    }
    if (Array.isArray(data.content)) await restoreContent(deps, vault, data.content);
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(data), { status: upstream.status, headers });
  }
  log("streamed", inspection, upstream.status);
  return new Response(streamOf(streamEvents(upstream.body, vault)), { status: upstream.status, headers });
}

export function anthropicRoutes(app: Hono, deps: Deps): void {
  app.post("/v1/messages", (c) => guarded(deps, c, "anthropic.messages", "/v1/messages", true));
  // Counted on the redacted text, so the original values never reach the provider.
  app.post("/v1/messages/count_tokens", (c) =>
    guarded(deps, c, "anthropic.count_tokens", "/v1/messages/count_tokens", false),
  );
}
