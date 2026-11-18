/**
 * Vercel AI SDK middleware: redact, block injection and restore, in process, with no proxy.
 *
 *   import { wrapLanguageModel } from "ai";
 *   import { proxshieldMiddleware } from "proxshield/ai-sdk";
 *   const model = wrapLanguageModel({ model: openai("gpt-5"), middleware: proxshieldMiddleware() });
 */
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { type Config, defaultConfig } from "./config.js";
import { createGuard, type Guard, type Inspection, OutputStream } from "./guard.js";
import { isRecord, type Slot, setter } from "./proxy/common.js";
import { jsonStringEscape, StreamRestorer, Vault } from "./vault.js";

export class ProxshieldBlockedError extends Error {
  override readonly name = "ProxshieldBlockedError";
  constructor(
    message: string,
    readonly inspection: Inspection,
  ) {
    super(message);
  }
}

export interface MiddlewareOptions {
  /** A guard to share between models (models load once). Defaults to one built from `config`. */
  guard?: Guard;
  config?: Config;
}

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

/** Every piece of text in an AI SDK prompt, with a setter for the redacted version. */
export function collect(params: LanguageModelV4CallOptions): Slot[] {
  const slots: Slot[] = [];
  for (const message of params.prompt) {
    if (message.role === "system") {
      slots.push({ role: "system", text: message.content, put: setter(message, "content") });
      continue;
    }
    for (const part of message.content as unknown[]) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
        slots.push({ role: message.role, text: part.text, put: setter(part, "text") });
      } else if (part.type === "tool-call") {
        jsonStrings(part, "input", "tool_args", slots);
      } else if (part.type === "tool-result" && isRecord(part.output)) {
        const output = part.output;
        if ((output.type === "text" || output.type === "error-text") && typeof output.value === "string") {
          slots.push({ role: "tool", text: output.value, put: setter(output, "value") });
        } else if (output.type === "json" || output.type === "error-json") {
          jsonStrings(output, "value", "tool", slots);
        } else if (output.type === "content" && Array.isArray(output.value)) {
          for (const item of output.value) {
            if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
              slots.push({ role: "tool", text: item.text, put: setter(item, "text") });
            }
          }
        }
      }
    }
  }
  return slots;
}

/** Slots for every string in `holder[key]`, a JSON value that may itself be a string. */
function jsonStrings(holder: Record<string, unknown>, key: string, role: string, slots: Slot[]): void {
  const value = holder[key];
  if (typeof value === "string") slots.push({ role, text: value, put: setter(holder, key) });
  else strings(value, role, slots);
}

function restoreInput(vault: Vault, input: string): string {
  try {
    return JSON.stringify(vault.restoreJson(JSON.parse(input)));
  } catch {
    return vault.restore(input, jsonStringEscape);
  }
}

export function proxshieldMiddleware(options: MiddlewareOptions = {}): LanguageModelV4Middleware {
  const guard = options.guard ?? createGuard(options.config ?? defaultConfig());
  const vaults = new WeakMap<object, Vault>();

  return {
    specificationVersion: "v4",

    async transformParams({ params }) {
      const copy = structuredClone(params);
      const vault = new Vault();
      const slots = collect(copy);
      const inspection = await guard.inspect(slots, vault);
      if (inspection.blocked) throw new ProxshieldBlockedError(inspection.blocked, inspection);
      slots.forEach((s, i) => {
        s.put(inspection.texts[i] ?? s.text);
      });
      vaults.set(copy, vault);
      return copy;
    },

    async wrapGenerate({ doGenerate, params }) {
      const result = await doGenerate();
      const vault = vaults.get(params);
      if (!vault) return result;
      const content: LanguageModelV4Content[] = [];
      for (const part of result.content) {
        if (part.type === "text") {
          const { text } = await guard.scanOutput(part.text, vault);
          content.push({ ...part, text: vault.restore(text) });
        } else if (part.type === "tool-call") {
          content.push({ ...part, input: restoreInput(vault, part.input) });
        } else {
          content.push(part);
        }
      }
      return { ...result, content };
    },

    async wrapStream({ doStream, params }) {
      const result = await doStream();
      const vault = vaults.get(params);
      if (!vault) return result;
      const text = new Map<string, OutputStream>();
      const tool = new Map<string, StreamRestorer>();
      const restorer = (id: string) => {
        let r = tool.get(id);
        if (!r) {
          r = new StreamRestorer(vault, jsonStringEscape);
          tool.set(id, r);
        }
        return r;
      };
      const masker = (id: string) => {
        let r = text.get(id);
        if (!r) {
          r = new OutputStream(guard, vault);
          text.set(id, r);
        }
        return r;
      };
      const stream = result.stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          async transform(part, controller) {
            if (part.type === "text-delta") {
              const delta = await masker(part.id).feed(part.delta);
              if (delta) controller.enqueue({ ...part, delta });
            } else if (part.type === "text-end") {
              const rest = await text.get(part.id)?.finish();
              text.delete(part.id);
              if (rest) controller.enqueue({ type: "text-delta", id: part.id, delta: rest });
              controller.enqueue(part);
            } else if (part.type === "tool-input-delta") {
              controller.enqueue({ ...part, delta: restorer(part.id).feed(part.delta) });
            } else if (part.type === "tool-input-end") {
              const rest = tool.get(part.id)?.finish();
              if (rest) controller.enqueue({ type: "tool-input-delta", id: part.id, delta: rest });
              controller.enqueue(part);
            } else if (part.type === "tool-call") {
              controller.enqueue({ ...part, input: restoreInput(vault, part.input) });
            } else {
              controller.enqueue(part);
            }
          },
        }),
      );
      return { ...result, stream };
    },
  };
}
