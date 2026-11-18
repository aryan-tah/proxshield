---
title: Configuration
description: Choose what to redact, mask or block, and where requests go.
---

proxshield runs with no configuration. To change anything, write a TOML file and pass it with `--config` or `PROXSHIELD_CONFIG`. Environment variables override the file.

## A full example

```toml
[pii]
# "bert" (default), "privacy-filter", or "none" for patterns only.
model = "bert"
# Minimum model confidence for names, places and addresses.
threshold = 0.8
# Region for phone numbers written without a country code.
phone_region = "US"

[pii.entities]
# allow, redact, mask or block. Unlisted types keep their defaults.
CREDIT_CARD = "block"
LOCATION = "redact"
DATE = "allow"

[[pii.custom]]
name = "EMPLOYEE_ID"
pattern = 'EMP-\d{6}'
action = "redact"

[output]
# Personal data in a reply that wasn't in the request: "mask" (default) or "allow".
pii = "mask"

[injection]
enabled = true
# "prompt-guard-2" (default: fewer false alarms) or "protectai" (catches more, flags more).
model = "prompt-guard-2"
threshold = 0.9
# Message roles scanned for injection. "tool" covers tool results and documents.
roles = ["user", "tool"]
# "block" (default) or "allow" to only report it.
action = "block"
# Long texts from these roles are also scored a few sentences at a time.
chunk_roles = ["tool"]
chunk_chars = 150

[upstream]
openai_base_url = "https://api.openai.com/v1"
anthropic_base_url = "https://api.anthropic.com"
timeout_seconds = 600

[server]
# "error" returns the provider's error format; "refusal" returns a normal reply saying no.
block_mode = "error"
refusal_message = "I can't help with that request."
max_body_bytes = 4194304
```

## Entity types

| Type | Default | Found by |
| --- | --- | --- |
| `EMAIL` | redact | pattern |
| `PHONE` | redact | libphonenumber |
| `CREDIT_CARD` | redact | pattern + Luhn |
| `US_SSN` | redact | pattern + range check |
| `IBAN` | redact | pattern + mod-97 |
| `IP_ADDRESS` | redact | pattern + parser |
| `SECRET` | mask | key formats, entropy |
| `PERSON` | redact | model |
| `LOCATION` | allow | BERT NER |
| `ORGANIZATION` | allow | BERT NER |
| `ADDRESS` | redact | Privacy Filter |
| `ACCOUNT_NUMBER` | redact | Privacy Filter |
| `DATE` | allow | Privacy Filter |
| `URL` | allow | Privacy Filter |

Custom patterns are JavaScript regular expressions. Names must be `UPPER_SNAKE_CASE`; they become the placeholder prefix (`[EMPLOYEE_ID_1]`).

## Keys

There are two ways to handle provider keys.

**Pass-through (default).** Apps keep sending their own OpenAI or Anthropic key, and proxshield forwards it. If you set `PROXSHIELD_API_KEYS`, apps also have to send one of those keys in an `x-proxshield-key` header.

**Keys on the server.** Set `PROXSHIELD_OPENAI_API_KEY` or `PROXSHIELD_ANTHROPIC_API_KEY` and apps never see the provider key. They authenticate to proxshield with one of `PROXSHIELD_API_KEYS` in the normal `Authorization` (or `x-api-key`) header, and proxshield swaps in the real key.

```bash
docker run -p 8080:8080 \
  -e PROXSHIELD_API_KEYS=team-a-key,team-b-key \
  -e PROXSHIELD_OPENAI_API_KEY=sk-... \
  ghcr.io/aryan-tah/proxshield
```

The [Lakera](/migrate/lakera/) and [LLM Guard](/migrate/llm-guard/) endpoints check `PROXSHIELD_API_KEYS` as a bearer token.

With a provider key on the server, `PROXSHIELD_API_KEYS` is required whenever proxshield listens on anything other than localhost (the Docker image listens on `0.0.0.0`). Without it, anyone who can reach the port would spend your key, so proxshield refuses to start. If a gateway in front of proxshield already authenticates callers, set `PROXSHIELD_ALLOW_UNAUTHENTICATED=1` (or `[server] allow_unauthenticated = true`). In pass-through mode it starts with a warning instead, since callers bring their own provider key.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `PROXSHIELD_CONFIG` | Path to the TOML file |
| `PROXSHIELD_API_KEYS` | Comma-separated keys clients use for proxshield |
| `PROXSHIELD_OPENAI_API_KEY`, `PROXSHIELD_ANTHROPIC_API_KEY` | Keep provider keys on the server |
| `PROXSHIELD_ALLOW_UNAUTHENTICATED` | `1` starts without `PROXSHIELD_API_KEYS` on a public address even with a provider key on the server |
| `PROXSHIELD_OPENAI_BASE_URL`, `PROXSHIELD_ANTHROPIC_BASE_URL` | Where to forward requests |
| `PROXSHIELD_PII_MODEL` | `bert`, `privacy-filter` or `none` |
| `PROXSHIELD_INJECTION_MODEL` | `prompt-guard-2` or `protectai` |
| `PROXSHIELD_INJECTION_THRESHOLD` | Block at or above this score |
| `PROXSHIELD_BLOCK_MODE` | `error` or `refusal` |
| `PROXSHIELD_CACHE_DIR` | Where models are stored (default `~/.cache/proxshield`) |
| `PROXSHIELD_OFFLINE` | `1` never downloads models (set in the Docker image) |
| `PROXSHIELD_THREADS` | CPU threads per model |
| `PROXSHIELD_PRELOAD` | `0` skips loading models at startup |
| `PROXSHIELD_HOST`, `PORT` | Where to listen (default `127.0.0.1:8080`, `0.0.0.0` in Docker) |

## Other providers

Anything that speaks OpenAI's Chat Completions API works as the upstream: Azure OpenAI's v1 endpoint, OpenRouter, Groq, Together, vLLM, Ollama or LiteLLM.

```toml
[upstream]
openai_base_url = "http://localhost:11434/v1"   # Ollama
```
