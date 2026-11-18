---
title: HTTP API
description: Every route proxshield serves.
---

| Method and path | What it does |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI proxy: redact, check, forward, restore |
| `GET /v1/models` | Passed through to the OpenAI-compatible upstream |
| `POST /v1/messages` | Anthropic proxy: redact, check, forward, restore |
| `POST /v1/messages/count_tokens` | Redacted, then forwarded |
| `POST /v2/guard` | Lakera Guard compatible screening ([details](/migrate/lakera/)) |
| `POST /analyze/prompt`, `/scan/prompt` | LLM Guard API compatible ([details](/migrate/llm-guard/)) |
| `POST /analyze/output`, `/scan/output` | LLM Guard API compatible |
| `GET /healthz` | `{"status": "alive"}` while the process runs |
| `GET /readyz` | 200 `{"status": "ready"}` once models are loaded, 503 before |
| `GET /` | Name and version |

Any other route returns 404. proxshield never forwards a route it doesn't scan.

## Headers

Requests:

| Header | Meaning |
| --- | --- |
| `authorization`, `x-api-key` | The provider key, passed through. When the provider key is kept on the server, these carry the proxshield key instead. |
| `x-proxshield-key` | A proxshield key, when `PROXSHIELD_API_KEYS` is set and the provider key is passed through. Never forwarded. |

All other request headers (`anthropic-version`, `openai-organization`, `anthropic-beta` and so on) are forwarded unchanged, apart from hop-by-hop headers.

Responses from the proxy routes:

| Header | Example | Meaning |
| --- | --- | --- |
| `x-proxshield-redacted` | `EMAIL=1,PERSON=2` | Values replaced in the request, by type. Absent when nothing was. |
| `x-proxshield-injection-score` | `0.03` | Highest injection score across the scanned messages |

Provider response headers (`x-request-id`, rate-limit headers, `retry-after`) are passed back unchanged.

## Status codes

| Status | When |
| --- | --- |
| 400 | Blocked (in the provider's error format), or the body isn't a JSON object |
| 401 | A proxshield key is required and missing or wrong |
| 404 | Route not handled |
| 422 | LLM Guard routes: a required field is missing |
| 502 | The provider couldn't be reached |
| Anything else | Passed through from the provider |
