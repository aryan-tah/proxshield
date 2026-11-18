/** Command line: `proxshield serve`, `proxshield scan` and `proxshield download`. */
import { parseArgs } from "node:util";
import { actionFor, type Config, loadConfig } from "./config.js";
import { bertNer, privacyFilter, TransformersInjection } from "./detectors/models.js";
import { createGuard } from "./guard.js";
import { Vault } from "./vault.js";
import { VERSION } from "./version.js";

const HELP = `proxshield ${VERSION}: a self-hosted firewall for LLM apps.

Usage:
  proxshield serve [--config FILE] [--host HOST] [--port PORT]
  proxshield scan [--config FILE] [--role user|tool|system|assistant] [--json] <text | ->
  proxshield download [--privacy-filter]

Environment: PROXSHIELD_CONFIG, PROXSHIELD_API_KEYS, PROXSHIELD_OPENAI_API_KEY,
PROXSHIELD_ANTHROPIC_API_KEY, PROXSHIELD_PII_MODEL, PROXSHIELD_CACHE_DIR, PORT.
Docs: https://proxshield.aryantah.com`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  stdin: () => Promise<string>;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  stdin: async () => {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data;
  },
};

async function serve(config: Config, host: string, port: number, io: Io): Promise<number> {
  const { serve: listen } = await import("@hono/node-server");
  const { createApp } = await import("./app.js");
  const { app, ready } = createApp({ config });
  listen({ fetch: app.fetch, hostname: host, port });
  io.err(`proxshield ${VERSION} listening on http://${host}:${port} (loading models…)`);
  await ready();
  io.err("proxshield ready.");
  return new Promise(() => {}); // run until killed
}

async function scan(config: Config, text: string, role: string, json: boolean, io: Io): Promise<number> {
  const guard = createGuard(config);
  const inspection = await guard.inspect([{ role, text }], new Vault());
  const result = {
    redacted: inspection.texts[0] ?? "",
    findings: (inspection.findings[0] ?? []).map((f) => ({
      entity: f.entity,
      text: f.text,
      start: f.start,
      end: f.end,
      score: Number(f.score.toFixed(3)),
      detector: f.detector,
      action: actionFor(config, f.entity),
    })),
    injection: inspection.injections.map((r) => ({
      score: Number(r.score.toFixed(3)),
      reasons: r.reasons,
      model_score: r.modelScore === null ? null : Number(r.modelScore.toFixed(3)),
    })),
    blocked: inspection.blocked,
  };
  if (json) {
    io.out(JSON.stringify(result, null, 2));
  } else {
    io.out(result.redacted);
    for (const f of result.findings) {
      io.out(
        `  ${f.entity.padEnd(14)} ${f.action.padEnd(7)} ${JSON.stringify(f.text)} (${f.detector}, ${f.score})`,
      );
    }
    for (const r of result.injection)
      io.out(`  injection score ${r.score} (reasons: ${r.reasons.join(", ") || "none"})`);
    if (result.blocked) io.out(`  BLOCKED: ${result.blocked}`);
  }
  return inspection.blocked ? 1 : 0;
}

async function download(config: Config, withPrivacyFilter: boolean, io: Io): Promise<number> {
  const opts = { cacheDir: config.cacheDir };
  const models = [new TransformersInjection(opts, config.injectionModel), bertNer(opts)];
  if (withPrivacyFilter) models.push(privacyFilter(opts));
  for (const m of models) {
    io.err(`Downloading ${m.name}…`);
    await m.load();
  }
  io.err("Done.");
  return 0;
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    io.out(HELP);
    return command ? 0 : 2;
  }
  if (command === "--version" || command === "-v") {
    io.out(VERSION);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        host: { type: "string" },
        port: { type: "string" },
        role: { type: "string", default: "user" },
        json: { type: "boolean", default: false },
        "privacy-filter": { type: "boolean", default: false },
      },
    });
    const config = loadConfig(values.config);
    if (command === "serve") {
      const host = values.host ?? process.env.PROXSHIELD_HOST ?? "127.0.0.1";
      const port = Number(values.port ?? process.env.PORT ?? 8080);
      return await serve(config, host, port, io);
    }
    if (command === "scan") {
      const arg = positionals[0];
      if (arg === undefined) throw new Error("scan needs some text, or - to read standard input");
      const text = arg === "-" ? await io.stdin() : arg;
      if (!["system", "user", "assistant", "tool"].includes(values.role))
        throw new Error(`unknown role ${values.role}`);
      return await scan(config, text, values.role, values.json, io);
    }
    if (command === "download") return await download(config, values["privacy-filter"], io);
    io.err(`proxshield: unknown command ${JSON.stringify(command)}\n\n${HELP}`);
    return 2;
  } catch (e) {
    io.err(`proxshield: ${(e as Error).message}`);
    return 2;
  }
}
