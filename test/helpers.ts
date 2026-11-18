import { createApp } from "../src/app.js";
import { type Config, defaultConfig } from "../src/config.js";
import { createGuard, type Guard } from "../src/guard.js";

export function fakeConfig(overrides: Partial<Config> = {}): Config {
  return defaultConfig({ backend: "fake", preload: false, ...overrides });
}

export function fakeGuard(overrides: Partial<Config> = {}): Guard {
  return createGuard(fakeConfig(overrides));
}

/** A fake provider. Records what proxshield sent and answers with a canned response. */
export class Upstream {
  requests: { url: string; headers: Headers; body: string }[] = [];
  respond: (req: { url: string; body: string }) => Response = () => Response.json({});

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? init.body : "";
    this.requests.push({ url, headers: new Headers(init?.headers), body });
    return this.respond({ url, body });
  };

  get last(): { url: string; headers: Headers; json: Record<string, unknown> } {
    const r = this.requests.at(-1);
    if (!r) throw new Error("no upstream request");
    return { url: r.url, headers: r.headers, json: JSON.parse(r.body) as Record<string, unknown> };
  }
}

export function setup(overrides: Partial<Config> = {}) {
  const upstream = new Upstream();
  const { app } = createApp({ config: fakeConfig(overrides), fetch: upstream.fetch, log: () => {} });
  const call = (path: string, init?: RequestInit) => app.request(path, init);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    });
  /** A fetch for SDK clients: sends their requests to the in-memory app. */
  const sdkFetch = (input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(app.fetch(new Request(input, init)));
  return { app, upstream, call, post, sdkFetch };
}

export function sse(...events: string[]): Response {
  return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
}

export async function* noop(): AsyncGenerator<string> {}
