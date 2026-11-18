/**
 * OpenAI-compatible proxy: `POST /v1/chat/completions` and `GET /v1/models`. Works with the
 * OpenAI SDKs and anything that speaks Chat Completions (vLLM, Ollama, OpenRouter, LiteLLM,
 * Groq, Together) by pointing `baseURL` at proxshield.
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

const ROLE: Record<string, string> = {
  system: "system",
  developer: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
  function: "tool",
};

function error(message: string, status = 400, code = "proxshield_blocked"): Response {
  return Response.json({ error: { message, type: "invalid_request_error", param: null, code } }, { status });
}

/** Every piece of text in the request, with a setter to write the redacted version back. */
export function collect(body: Json): Slot[] {
  const slots: Slot[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    const role = ROLE[String(msg.role)] ?? "user";
    if (typeof msg.content === "string") {
      slots.push({ role, text: msg.content, put: setter(msg, "content") });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
          slots.push({ role, text: part.text, put: setter(part, "text") });
        }
      }
    }
    for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
      const fn = isRecord(call) ? call.function : null;
      if (isRecord(fn) && typeof fn.arguments === "string") {
        slots.push({ role: "tool_args", text: fn.arguments, put: setter(fn, "arguments") });
      }
    }
  }
  return slots;
}

function restoreArguments(vault: Vault, args: string): string {
  try {
    return JSON.stringify(vault.restoreJson(JSON.parse(args)));
  } catch {
    return vault.restore(args, jsonStringEscape);
  }
}

async function restoreMessage(deps: Deps, vault: Vault, message: Json): Promise<void> {
  if (typeof message.content === "string") {
    const { text } = await deps.guard.scanOutput(message.content, vault);
    message.content = vault.restore(text);
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const fn = isRecord(call) ? call.function : null;
    if (isRecord(fn) && typeof fn.arguments === "string")
      fn.arguments = restoreArguments(vault, fn.arguments);
  }
  const fc = message.function_call;
  if (isRecord(fc) && typeof fc.arguments === "string") fc.arguments = restoreArguments(vault, fc.arguments);
}

function refusal(deps: Deps, body: Json, inspection: Inspection): Response {
  const model = String(body.model ?? "proxshield");
  const id = `chatcmpl-proxshield-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const headers = findingsHeaders(deps.config, inspection);
  const text = deps.config.refusalMessage;
  if (body.stream) {
    const chunk = (delta: Json, finish: string | null) =>
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const events = [chunk({ role: "assistant", content: text }, null), chunk({}, "stop"), "data: [DONE]\n\n"];
    return new Response(events.join(""), { headers: { ...headers, "content-type": "text/event-stream" } });
  }
  return Response.json(
    {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
    { headers },
  );
}

/** Restores placeholders in a Chat Completions SSE stream. */
export class StreamTransformer {
  private readonly text = new Map<number, StreamRestorer>();
  private readonly args = new Map<string, StreamRestorer>();
  private template: Json | null = null;

  constructor(private readonly vault: Vault) {}

  private chunkFor(index: number, delta: Json): Json {
    const chunk: Json = structuredClone(this.template ?? {});
    chunk.choices = [{ index, delta, finish_reason: null }];
    delete chunk.usage;
    return chunk;
  }

  /** Chunks carrying text still held back, for one choice (or all of them). */
  private flush(index: number | null): Json[] {
    if (this.template === null) return [];
    const out: Json[] = [];
    for (const [i, r] of this.text) {
      if (index !== null && i !== index) continue;
      const rest = r.finish();
      if (rest) out.push(this.chunkFor(i, { content: rest }));
    }
    for (const [key, r] of this.args) {
      const [i, t] = key.split(":").map(Number) as [number, number];
      if (index !== null && i !== index) continue;
      const rest = r.finish();
      if (rest) out.push(this.chunkFor(i, { tool_calls: [{ index: t, function: { arguments: rest } }] }));
    }
    return out;
  }

  chunk(data: Json): Json[] {
    const choices = Array.isArray(data.choices) ? data.choices : [];
    if (this.template === null && choices.length) {
      const { choices: _, ...rest } = data;
      this.template = rest;
    }
    const before: Json[] = [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const index = Number(choice.index ?? 0);
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string") {
        const r = this.text.get(index) ?? new StreamRestorer(this.vault);
        this.text.set(index, r);
        delta.content = r.feed(delta.content);
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const fn = isRecord(call) ? call.function : null;
        if (isRecord(call) && isRecord(fn) && typeof fn.arguments === "string") {
          const key = `${index}:${Number(call.index ?? 0)}`;
          const r = this.args.get(key) ?? new StreamRestorer(this.vault, jsonStringEscape);
          this.args.set(key, r);
          fn.arguments = r.feed(fn.arguments);
        }
      }
      if (choice.finish_reason) before.push(...this.flush(index));
    }
    return [...before, data];
  }

  done(): Json[] {
    return this.flush(null);
  }
}

async function* streamEvents(body: ReadableStream<Uint8Array>, vault: Vault): AsyncGenerator<string> {
  const t = new StreamTransformer(vault);
  const emit = (chunk: Json) => `data: ${JSON.stringify(chunk)}\n\n`;
  for await (const line of lines(body)) {
    if (!line.startsWith("data:")) {
      if (line.trim()) yield `${line}\n\n`;
      continue;
    }
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      for (const c of t.done()) yield emit(c);
      yield "data: [DONE]\n\n";
      continue;
    }
    let data: Json;
    try {
      data = JSON.parse(payload) as Json;
    } catch {
      yield `${line}\n\n`;
      continue;
    }
    for (const c of t.chunk(data)) yield emit(c);
  }
  for (const c of t.done()) yield emit(c); // streams that end without [DONE]
}

function authorized(deps: Deps, c: Context): boolean {
  const serverKey = deps.config.openaiApiKey;
  return keyOk(deps.config, [c.req.header("x-proxshield-key"), serverKey ? bearer(c) : null]);
}

async function chatCompletions(deps: Deps, c: Context): Promise<Response> {
  const { config, guard } = deps;
  const log = requestLog(deps, "openai.chat");
  if (!authorized(deps, c)) {
    log("unauthorized", null, 401);
    return error("Invalid proxshield key.", 401, "invalid_api_key");
  }
  const body = await readJson(c, config);
  if (body === null)
    return error("Request body must be a JSON object under the size limit.", 400, "invalid_request");

  const vault = new Vault();
  const slots = collect(body);
  const inspection = await guard.inspect(slots, vault);
  if (inspection.blocked) {
    log("blocked", inspection, 400);
    if (config.blockMode === "refusal") return refusal(deps, body, inspection);
    const res = error(inspection.blocked);
    for (const [k, v] of Object.entries(findingsHeaders(config, inspection))) res.headers.set(k, v);
    return res;
  }
  slots.forEach((s, i) => {
    s.put(inspection.texts[i] ?? s.text);
  });

  const serverKey = config.openaiApiKey;
  const url = new URL(`${config.openaiBaseUrl}/chat/completions`);
  url.search = new URL(c.req.url).search;
  let upstream: Response;
  try {
    upstream = await deps.fetch(url, {
      method: "POST",
      headers: forwardHeaders(c, [], serverKey ? { authorization: `Bearer ${serverKey}` } : {}),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
  } catch (e) {
    log("upstream_error", inspection, 502);
    return error(`Upstream request failed: ${(e as Error).name}.`, 502, "upstream_error");
  }

  const headers = responseHeaders(upstream.headers, config, inspection);
  const isSse = (upstream.headers.get("content-type") ?? "").startsWith("text/event-stream");
  if (upstream.status >= 400 || !isSse || !upstream.body) {
    const raw = await upstream.text();
    log("forwarded", inspection, upstream.status);
    if (upstream.status >= 400 || !raw) return new Response(raw, { status: upstream.status, headers });
    let data: Json;
    try {
      data = JSON.parse(raw) as Json;
    } catch {
      return new Response(raw, { status: upstream.status, headers });
    }
    for (const choice of Array.isArray(data.choices) ? data.choices : []) {
      if (isRecord(choice) && isRecord(choice.message)) await restoreMessage(deps, vault, choice.message);
    }
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(data), { status: upstream.status, headers });
  }
  log("streamed", inspection, upstream.status);
  return new Response(streamOf(streamEvents(upstream.body, vault)), { status: upstream.status, headers });
}

async function models(deps: Deps, c: Context): Promise<Response> {
  if (!authorized(deps, c)) return error("Invalid proxshield key.", 401, "invalid_api_key");
  const serverKey = deps.config.openaiApiKey;
  try {
    const r = await deps.fetch(`${deps.config.openaiBaseUrl}/models`, {
      headers: forwardHeaders(c, [], serverKey ? { authorization: `Bearer ${serverKey}` } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    return new Response(await r.text(), {
      status: r.status,
      headers: responseHeaders(r.headers, deps.config, null),
    });
  } catch (e) {
    return error(`Upstream request failed: ${(e as Error).name}.`, 502, "upstream_error");
  }
}

export function openaiRoutes(app: Hono, deps: Deps): void {
  app.post("/v1/chat/completions", (c) => chatCompletions(deps, c));
  app.get("/v1/models", (c) => models(deps, c));
}
