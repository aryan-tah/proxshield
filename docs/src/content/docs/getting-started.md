---
title: Getting started
description: Run proxshield, point an app at it, and see what it redacts.
---

## Run it

The Docker image includes the models, so it starts without downloading anything:

```bash
docker run -p 8080:8080 ghcr.io/aryan-tah/proxshield
```

It needs about 1 GB of memory and no GPU. Startup takes a few seconds while the models load. It's ready when this says `ready`:

```bash
curl localhost:8080/readyz
```

To run it without Docker you need Node 20 or newer:

```bash
npx proxshield serve --host 0.0.0.0 --port 8080
```

The first start downloads the models (about 400 MB) into `~/.cache/proxshield`.

## See what it finds

`proxshield scan` shows what would be redacted or blocked in a piece of text:

```bash
npx proxshield scan "Hi, I'm Jordan Lee. Call me at (415) 555-0132 or use card 4111 1111 1111 1111."
```

```text
Hi, I'm [PERSON_1]. Call me at [PHONE_1] or use card [CREDIT_CARD_1].
  PERSON         redact  "Jordan Lee" (ner, 0.995)
  PHONE          redact  "(415) 555-0132" (pattern, 0.9)
  CREDIT_CARD    redact  "4111 1111 1111 1111" (pattern, 1)
  injection score 0.001 (reasons: none)
```

Use `--role tool` to scan text the way proxshield scans tool results and retrieved documents, and `--json` for machine-readable output.

## Point your app at it

proxshield speaks the OpenAI and Anthropic APIs. Change the base URL and keep your provider key where it is; proxshield passes it through.

```ts
import OpenAI from "openai";

const openai = new OpenAI({ baseURL: "http://localhost:8080/v1" });
```

```ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ baseURL: "http://localhost:8080" });
```

Each response carries two headers that say what happened:

| Header | Example |
| --- | --- |
| `x-proxshield-redacted` | `EMAIL=1,PERSON=2` |
| `x-proxshield-injection-score` | `0.02` |

If a request is blocked, the app gets the provider's normal error format with status 400, so its existing error handling works. See [Configuration](/guides/configuration/) to return a polite refusal instead.

## Next

- [How it works](/guides/how-it-works/): what gets detected, and how placeholders come back.
- [Configuration](/guides/configuration/): choose what to redact, mask or block.
- [Vercel AI SDK](/integrations/ai-sdk/): use it in-process, without running the proxy.
