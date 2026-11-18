---
title: Vercel AI SDK
description: Use proxshield inside your app as AI SDK middleware, with no proxy to run.
---

If your app uses the [AI SDK](https://ai-sdk.dev), you can skip the proxy and run proxshield in-process. It works with every provider the AI SDK supports.

```bash
npm install proxshield
```

```ts
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { proxshieldMiddleware } from "proxshield/ai-sdk";

const model = wrapLanguageModel({
  model: openai("gpt-5"),
  middleware: proxshieldMiddleware(),
});

const { text } = await generateText({
  model,
  prompt: "Draft a reply to Jordan Lee (jordan@acme.com) about the late refund.",
});
// The model saw [PERSON_1] and [EMAIL_1]; `text` has the real values back.
```

Streaming (`streamText`), tool calls and tool results work the same way. Text deltas, tool-input deltas and final tool-call inputs are restored.

## Blocked requests

If a prompt or tool result is an injection, the call throws before the model is called:

```ts
import { ProxshieldBlockedError } from "proxshield/ai-sdk";

try {
  await generateText({ model, prompt });
} catch (e) {
  if (e instanceof ProxshieldBlockedError) console.warn(e.message);
  else throw e;
}
```

## Sharing models between wrapped models

Each `proxshieldMiddleware()` call loads its own copy of the models. To wrap several models, build one guard and share it:

```ts
import { createGuard, defaultConfig } from "proxshield";
import { proxshieldMiddleware } from "proxshield/ai-sdk";

const guard = createGuard(defaultConfig({ piiModel: "privacy-filter" }));
await guard.warmup(); // optional: load the models now instead of on the first call

const middleware = proxshieldMiddleware({ guard });
```

The middleware targets the AI SDK's v4 language model specification (AI SDK 7).
