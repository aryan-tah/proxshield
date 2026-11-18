---
title: Anthropic
description: Put proxshield in front of the Anthropic Messages API.
---

proxshield handles `POST /v1/messages` (streaming and non-streaming) and `POST /v1/messages/count_tokens`.

## TypeScript

```ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ baseURL: "http://localhost:8080" });
```

## Python

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://localhost:8080")
```

Or set `ANTHROPIC_BASE_URL=http://localhost:8080`.

## What gets scanned

| Part of the request | Redacted | Checked for injection |
| --- | --- | --- |
| `system` (string or text blocks) | yes | no |
| `user` text | yes | yes |
| `assistant` text and `tool_use` input | yes | no |
| `tool_result` content (string or text blocks) | yes | yes, a few sentences at a time |
| `document` blocks with a text source | yes | yes |

In replies, text blocks and `tool_use` input are restored. In streams, `text_delta` and `input_json_delta` events are restored, with JSON escaping for tool input. Thinking blocks are passed through untouched so their signatures stay valid.

`count_tokens` is counted on the redacted request, so the original values never reach Anthropic for that call either.

## When a request is blocked

```json
{
  "type": "error",
  "error": { "type": "invalid_request_error", "message": "Possible prompt injection in a tool result (score 0.98)." }
}
```
