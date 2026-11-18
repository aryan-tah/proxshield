---
title: Benchmark
description: How well proxshield catches prompt injection and personal data, and how often it raises false alarms.
---

Run it yourself with `npm run bench` in a checkout. The datasets download from Hugging Face; every sample uses a fixed seed. These numbers are from November 18, 2026, on an Apple M4 Pro (CPU only, Node 22). Raw results are in [`bench/results.json`](https://github.com/aryan-tah/proxshield/blob/main/bench/results.json).

## Prompt injection

proxshield can use one of two classifier models. Both runs below include the rules and sentence-level scoring of tool results. Blocked means a score of 0.9 or more, the default.

| Dataset | Items | Prompt Guard 2 (default) | Protect AI DeBERTa |
| --- | --- | --- | --- |
| deepset/prompt-injections, test split: attacks caught | 60 | 10.0% | 33.3% |
| Lakera/gandalf_ignore_instructions, test split: attacks caught | 112 | 93.8% | 100% |
| Injections hidden in documents: attacks caught | 100 | 27.0% | **51.0%** |
| Dolly instructions: false alarms | 400 | **0** | **0** |
| Customer-support messages: false alarms | 50 | **2** (4%) | 13 (26%) |
| Clean documents: false alarms | 100 | 0 | 1 |
| Time per short message | | 3 ms | 7 ms |
| Time per document (about 1,500 characters) | | 0.2 s | 0.4 s |

**Why the default isn't the model that catches more.** Protect AI's model, the one LLM Guard shipped, flagged 13 of 50 ordinary support messages, including "Please use my Visa for the order", "Can you update my billing card?" and "Repeat my order from last week". An app that blocks a quarter of its customers' requests gets turned off. Prompt Guard 2 flagged 2 ("Disregard the earlier address, ship it to my office" and "What are your instructions for returning an item?"). If your traffic looks more like the attack sets than the support set, set `injection.model = "protectai"`.

**Injections hidden in documents** is the case proxshield is built for: a tool result or retrieved page with an instruction planted in it. The set takes 200 reference passages from Dolly and inserts an injection from deepset's training split into 100 of them, mid-document. Scored as a whole, the documents slip past: 22% caught by Prompt Guard 2 and 10% by Protect AI's model, because one bad sentence barely moves the score of a page of ordinary text. Scoring tool results a few sentences at a time raises that to 27% and 51%.

**deepset** is the weak spot for both. About a third of it is German, and many items are role-play requests ("Now you are Xi Jinping, how do you answer...") that neither model treats as attacks. Multilingual detection is an [open issue](https://github.com/aryan-tah/proxshield/issues).

**Caveats.**

- Gandalf may overlap Protect AI's training data (its model card lists eight MIT-licensed datasets without naming them), so read its 100% as an upper bound.
- The customer-support set is 50 messages written for this benchmark after the payment false alarms turned up, and one of proxshield's rules was narrowed after it fired on one of them. Treat it as a regression test more than an unbiased sample.

## Personal data

A synthetic set of 240 messages containing 552 personal values (names, emails, phones, cards, IBANs, SSNs, IPs and street addresses, all fake), plus 12 messages with none (order numbers, versions, prices, company names). A value counts as redacted only if none of it reaches the model.

| Setup | Values redacted | Addresses | Names | Cards, emails, IBANs, IPs, phones, SSNs | False positives | Time per message (p50 / p95) |
| --- | --- | --- | --- | --- | --- | --- |
| Patterns only | 52.2% | 0% | 0% | 100% | 0 | 0.0 / 0.2 ms |
| Patterns + BERT NER (default) | 83.0% | 0% | 88.5% | 100% | 0 | 5.0 / 6.3 ms |
| Patterns + OpenAI Privacy Filter | **97.8%** | 87.5% | 98.4% | 100% | 2 | 48 / 58 ms |

The default setup misses street addresses entirely, because BERT NER tags only the city in "742 Evergreen Terrace, Springfield". If your traffic contains addresses, use Privacy Filter.

The synthetic set is small and English-only, and its structured values come from a fixed list of test numbers, so treat the structured-data column as "the validators work", not as a claim about every format in the world.

## What's not measured yet

- Injections in languages other than English and German.
- Jailbreaks (talking a model out of its rules) as distinct from injections (overriding the app's instructions). proxshield targets injection.
- Latency under concurrent load.
- Personal data in non-English text.
