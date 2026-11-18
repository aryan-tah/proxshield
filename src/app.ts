import { Hono } from "hono";
import { lakeraRoutes } from "./compat/lakera.js";
import { llmGuardRoutes } from "./compat/llmguard.js";
import { type Config, defaultConfig } from "./config.js";
import { createGuard, type Guard } from "./guard.js";
import { anthropicRoutes } from "./proxy/anthropic.js";
import type { Deps } from "./proxy/common.js";
import { openaiRoutes } from "./proxy/openai.js";
import { VERSION } from "./version.js";

export interface AppOptions {
  config?: Config;
  guard?: Guard;
  /** The fetch used to reach providers. Tests pass a fake. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface ProxshieldApp {
  app: Hono;
  guard: Guard;
  /** Load the models. Until it resolves, `/readyz` reports `loading`. */
  ready: () => Promise<void>;
}

export function createApp(options: AppOptions = {}): ProxshieldApp {
  const config = options.config ?? defaultConfig();
  const guard = options.guard ?? createGuard(config);
  const deps: Deps = {
    config,
    guard,
    fetch: options.fetch ?? globalThis.fetch,
    log: options.log ?? ((line) => console.log(`${new Date().toISOString()} ${line}`)),
  };
  let isReady = !config.preload;
  const app = new Hono();

  app.get("/", (c) => c.json({ name: "proxshield", version: VERSION }));
  app.get("/healthz", (c) => c.json({ status: "alive" }));
  app.get("/readyz", (c) => c.json({ status: isReady ? "ready" : "loading" }, isReady ? 200 : 503));
  openaiRoutes(app, deps);
  anthropicRoutes(app, deps);
  lakeraRoutes(app, deps);
  llmGuardRoutes(app, deps);
  app.notFound((c) =>
    c.json(
      {
        error: {
          message: `proxshield doesn't handle ${c.req.method} ${c.req.path}. Unknown routes aren't forwarded, so nothing reaches a provider unscanned.`,
          type: "invalid_request_error",
          code: "not_found",
        },
      },
      404,
    ),
  );

  const ready = async () => {
    if (config.preload) await guard.warmup();
    isReady = true;
  };
  return { app, guard, ready };
}
