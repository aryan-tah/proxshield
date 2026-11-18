---
title: Other clients
description: LangChain, LiteLLM, plain HTTP, and using proxshield as a library.
---

Anything that lets you set an OpenAI or Anthropic base URL works.

## LangChain

```ts
import { ChatOpenAI } from "@langchain/openai";

const llm = new ChatOpenAI({ model: "gpt-5", configuration: { baseURL: "http://localhost:8080/v1" } });
```

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-5", base_url="http://localhost:8080/v1")
```

## LiteLLM

Point LiteLLM's `api_base` for a model at proxshield, so traffic goes app → LiteLLM → proxshield → provider:

```yaml
model_list:
  - model_name: gpt-5
    litellm_params:
      model: openai/gpt-5
      api_base: http://proxshield:8080/v1
```

## curl

```bash
curl localhost:8080/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model": "gpt-5", "messages": [{"role": "user", "content": "My SSN is 123-45-6789"}]}' -i
```

The response headers include `x-proxshield-redacted: US_SSN=1`.

## As a library

The detection engine is exported, for redacting text in your own code (a logging pipeline, a support-ticket export) without any model call:

```ts
import { createGuard, defaultConfig, Vault } from "proxshield";

const guard = createGuard(defaultConfig());
const vault = new Vault();
const { texts, blocked } = await guard.inspect([{ role: "user", text: ticket.body }], vault);

console.log(texts[0]);                // "Customer [PERSON_1] ([EMAIL_1]) asked for a refund"
console.log(vault.restore(texts[0])); // the original text
```
