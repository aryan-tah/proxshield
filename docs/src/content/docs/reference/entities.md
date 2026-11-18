---
title: Placeholders
description: What placeholders look like, and the rules for restoring them.
---

## Format

A placeholder is the entity type and a number in square brackets: `[EMAIL_1]`, `[PERSON_2]`, `[EMPLOYEE_ID_1]`.

- Numbers count per type within one request, starting at 1.
- The same value gets the same placeholder everywhere in the request. Matching ignores case for emails, formatting for phone, card and SSN numbers, and spaces for IBANs. "(415) 555-0132" and "415.555.0132" are the same `[PHONE_1]`.
- If the user's text already contains a placeholder-shaped string, that number is skipped, and the user's text is never restored.

## Restoring

A `redact` placeholder is restored in the reply when it appears:

- with brackets: `[EMAIL_1]`
- without them, as a whole word: `EMAIL_1` (models sometimes drop the brackets)

It isn't restored inside a longer token (`EMAIL_10` isn't `EMAIL_1`).

`mask` placeholders (secrets by default) are never restored. The model and the app both see `[SECRET_1]`.

## Personal data in replies

Before restoring, proxshield scans the reply for personal data that wasn't in the request and masks it with a fresh, unrestorable placeholder (`[EMAIL_2]`). Values from the request aren't affected, because the model only ever saw their placeholders. Set `[output] pii = "allow"` to turn this off. Streamed replies are scanned a sentence at a time, so text arrives in sentence-sized pieces instead of token by token; with `pii = "allow"` streams pass through as they arrive.

## Scope

A placeholder mapping lives for one request. In a multi-turn conversation, each request is redacted afresh, so the same person might be `[PERSON_1]` in one request and `[PERSON_2]` in another. The model only sees one request at a time, so this doesn't confuse it.
