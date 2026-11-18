---
title: OpenAI
description: Put proxshield in front of the OpenAI API, or any API that speaks Chat Completions.
---

proxshield handles `POST /v1/chat/completions` (streaming and non-streaming) and passes `GET /v1/models` through. Point the SDK's base URL at it.

## TypeScript

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "http://localhost:8080/v1",
});

const reply = await openai.chat.completions.create({
  model: "gpt-5",
  messages: [{ role: "user", content: "Write to Jordan Lee (jordan@acme.com) about the refund." }],
});
```

## Python

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1")
```

Or set `OPENAI_BASE_URL=http://localhost:8080/v1` and change no code at all.

## What gets scanned

| Part of the request | Redacted | Checked for injection |
| --- | --- | --- |
| `system` and `developer` messages | yes | no |
| `user` messages (text and text parts) | yes | yes |
| `assistant` messages and their `tool_calls[].function.arguments` | yes | no |
| `tool` and `function` messages | yes | yes, a few sentences at a time |

Placeholders in the reply's `content`, `tool_calls[].function.arguments` and `function_call.arguments` are restored, in streamed and non-streamed responses.

## When a request is blocked

The app gets a normal OpenAI error, so `openai.BadRequestError` (or your existing handling) catches it:

```json
{
  "error": {
    "message": "Possible prompt injection in a tool result (score 0.98).",
    "type": "invalid_request_error",
    "param": null,
    "code": "proxshield_blocked"
  }
}
```

With `block_mode = "refusal"`, the app gets a normal completion whose content is the refusal message instead.

## Not covered yet

The Responses API (`/v1/responses`), embeddings, the Realtime API and file uploads aren't handled in this version. proxshield returns 404 for routes it doesn't handle rather than forwarding them unscanned. Progress is tracked in the [issues](https://github.com/aryan-tah/proxshield/issues).
