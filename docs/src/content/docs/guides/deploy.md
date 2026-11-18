---
title: Deploy
description: Run proxshield in production, choose a PII model, and size it.
---

## Docker

```bash
docker run -d --name proxshield -p 8080:8080 \
  -v $PWD/proxshield.toml:/config.toml:ro \
  -e PROXSHIELD_CONFIG=/config.toml \
  ghcr.io/aryan-tah/proxshield:0.1
```

The image is multi-arch (amd64 and arm64), runs as a non-root user, and includes Llama Prompt Guard 2 and BERT NER, so it never needs network access except to reach your provider. `/readyz` returns 200 once the models are loaded; use it as the readiness probe and `/healthz` as the liveness probe.

## Using OpenAI Privacy Filter

Privacy Filter isn't in the default image, to keep it small. To use it, let the container download it once into a volume:

```bash
docker run -d -p 8080:8080 \
  -e PROXSHIELD_PII_MODEL=privacy-filter \
  -e PROXSHIELD_OFFLINE=0 \
  -v proxshield-models:/models \
  ghcr.io/aryan-tah/proxshield
```

The first start downloads about 0.9 GB.

| | BERT NER (default) | Privacy Filter |
| --- | --- | --- |
| Size | 110 MB | 0.9 GB |
| Finds | people, places, organizations | people, addresses, emails, phones, dates, URLs, account numbers, secrets |
| Values redacted in the benchmark | 100% | 99.5% |
| Time per message (p50, M4 Pro CPU) | 5 ms | 48 ms |

Patterns run in both cases, so structured data like cards and emails is caught either way.

## Sizing

Everything runs on CPU. On an Apple M4 Pro, a typical chat message adds about 15 ms with the default models (50 ms with Privacy Filter). Tool results longer than a few sentences take longer because they're also scored in chunks: about 0.2 s for a 1,500-character document with the default injection model, 0.4 s with `protectai`. Requests are handled concurrently; model inference runs on ONNX Runtime threads, so it doesn't block other requests from streaming.

Memory is about 1 GB with the default models, and 2.3 GB with Privacy Filter.

`PROXSHIELD_THREADS` caps the CPU threads each model uses, which helps when several containers share a machine.

## Model licenses

proxshield is Apache-2.0. The default injection model, Llama Prompt Guard 2, is under the [Llama 4 Community License](https://www.llama.com/llama4/license/) and is downloaded from an ONNX build by gravitee-io. Built with Llama. If you need every component under a permissive license, set `injection.model = "protectai"` (Apache-2.0) and accept its higher false-alarm rate. BERT NER is MIT and Privacy Filter is Apache-2.0.

## Without Docker

```bash
npm install -g proxshield
proxshield download            # add --privacy-filter to fetch it too
proxshield serve --host 0.0.0.0 --port 8080
```

## Where to put it

Run proxshield next to your app, on the same private network, and send it only traffic you control. It's a security boundary for data going out, not an authentication layer for the internet: put it behind your own gateway if it has to be reachable from outside.
