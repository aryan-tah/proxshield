---
title: How it works
description: The detectors, the placeholders, and what happens to a request on its way through.
---

Every request goes through four steps: find, decide, replace, and restore.

## 1. Find

proxshield reads every piece of text in the request: the system prompt, user and assistant messages, tool-call arguments from earlier turns, tool results and text documents. Images and files are passed through untouched.

Three kinds of detector look at each piece.

**Patterns with validity checks** find structured data. A regex alone would flag order numbers and version strings, so each match is checked:

| Entity | Check |
| --- | --- |
| Credit cards | Issuer prefix and the Luhn checksum |
| IBANs | Country length and the mod-97 checksum |
| US Social Security numbers | Number ranges that are never issued are skipped |
| Phone numbers | Parsed and validated with libphonenumber |
| IP addresses | Parsed as IPv4 or IPv6 |
| Emails | Domain shape |
| Secrets | Published key formats (OpenAI, Anthropic, AWS, GitHub, Stripe, Slack, Google and more), private key blocks, JWTs, passwords in connection strings, and `password=` style assignments with enough randomness |

**A model for names and places.** Patterns can't find "Jordan Lee", so a small token-classification model runs too. The default is BERT NER (110 MB), which finds people, places and organizations. [OpenAI Privacy Filter](https://huggingface.co/openai/privacy-filter) is the alternative (0.9 GB). It also finds non-US addresses, dates and account numbers. On the synthetic [benchmark](/reference/benchmark/) both setups redact nearly everything, so choose Privacy Filter for messier real-world text, not for the score.

**Prompt-injection detection** combines two things:

- Rules for the blunt cases: "ignore all previous instructions" and its paraphrases in English, German, Spanish and French; fake role markers like `<|im_start|>system`; requests for the system prompt; markdown images that leak data through a URL; and instructions hidden in invisible Unicode tag characters. Lookalike letters (a Cyrillic "і" in "іgnore") are folded first.
- A classifier model for paraphrases the rules miss. The default is Meta's [Llama Prompt Guard 2](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-22M) (22M parameters). Protect AI's [DeBERTa classifier](https://huggingface.co/protectai/deberta-v3-base-prompt-injection-v2), the one LLM Guard shipped, is the high-recall alternative: it catches more attacks but also flags ordinary requests like "Please use my Visa for the order". The [benchmark](/reference/benchmark/) has the numbers for both.

By default, injection is checked in user messages and tool results. Tool results are where indirect injection comes from: a web page, an email or a retrieved document with an instruction planted in it. A long document is scored as a whole and also a few sentences at a time. One injected sentence in a page of ordinary text barely moves the whole-document score; scored on its own, it stands out. In the benchmark this raised detection of hidden injections from 22% to 27% with the default model, and from 10% to 51% with the high-recall one.

## 2. Decide

Each entity type has an action:

| Action | What happens |
| --- | --- |
| `redact` | Replaced with a placeholder; the real value goes back into the reply |
| `mask` | Replaced with a placeholder that stays a placeholder |
| `block` | The whole request is rejected |
| `allow` | Left alone |

Defaults: names, emails, phones, cards, SSNs, IBANs, IPs, addresses and account numbers are redacted; secrets are masked; places, organizations, dates and URLs are allowed. An injection score of 0.9 or more blocks the request. All of this is [configurable](/guides/configuration/).

## 3. Replace

Values become typed, numbered placeholders: `[EMAIL_1]`, `[PERSON_2]`. The same value always gets the same placeholder within a request, so "Jordan Lee" in the system prompt and "Jordan Lee" in the third message are both `[PERSON_1]`, and the model can still tell people apart.

If the user's own text already contains something that looks like a placeholder, proxshield skips that number, so it never replaces text the user typed.

The mapping from placeholder to value lives in memory for the length of one request. It isn't logged, stored or shared between requests.

## 4. Restore

On the way back, placeholders in the reply become real values again: in the text, in tool-call arguments (with JSON escaping, so a value with quotes in it stays valid JSON), and in streamed responses.

Streaming is the tricky part. A placeholder can arrive split across chunks: `[EM` in one and `AIL_1]` in the next. proxshield holds back the few characters that could be the start of a placeholder until the next chunk shows whether they are, then sends them on. Everything else streams through immediately.

Models sometimes drop the brackets and write `EMAIL_1`; that is restored too.

Before restoring, proxshield also checks the reply for personal data that wasn't in the request (for example, an email the model pulled from a retrieved document) and masks it. This runs on non-streamed replies.

## What it logs

One line per request: the route, the decision, counts per entity type, the injection score and the time taken. Never the text.

```text
openai.chat decision=forwarded status=200 redacted=EMAIL=1,PERSON=2 injection=0.01 ms=9
```
