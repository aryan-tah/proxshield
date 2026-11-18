---
title: Limitations
description: What proxshield doesn't do, so you can decide what else you need.
---

proxshield reduces what reaches a model provider and blocks the most common injections. It isn't a guarantee, and it isn't a compliance certification. These are the gaps worth knowing about.

## Detection

- **Names are found by a model, and models miss some.** BERT NER redacted 88.5% of names in the benchmark; Privacy Filter 98.4%. Uncommon names, initials and names in non-Latin scripts are missed more often.
- **The default setup doesn't catch street addresses.** Use Privacy Filter if that matters.
- **Free-form sensitive data isn't detected**: medical conditions, a description of someone's situation, anything without a recognizable format or name.
- **Injection detection is mostly English, and recall is modest.** Rules cover German, Spanish and French overrides; the default model is English. On the deepset benchmark (a third German, many role-play prompts) the default catches 10% and the high-recall model 33%. Hidden injections in documents: 27% and 51%.
- **The two injection models trade false alarms for recall.** The default flagged 2 of 50 ordinary support messages; the high-recall model flagged 13.
- **A determined attacker can paraphrase past it.** Treat injection detection as one layer: give tools the least privilege they need, and confirm risky actions with a person.

## Coverage

- OpenAI Chat Completions and Anthropic Messages only. Not yet: the OpenAI Responses API, embeddings, Realtime, Gemini, Bedrock.
- Images, audio, PDFs and other files pass through unscanned.
- Personal data in streamed replies isn't masked (values from the request are still restored).
- Tool definitions aren't screened.

## Operations

- No built-in metrics endpoint or audit log yet; there's one log line per request with counts only.
- No rate limiting or per-key policies.
- Placeholders are per request, not per conversation.

The [issue tracker](https://github.com/aryan-tah/proxshield/issues) has the plan for each of these.
