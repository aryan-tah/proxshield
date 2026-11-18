/**
 * Structured personal data, found by pattern plus a validity check. The check is what keeps
 * false positives down: a 16-digit order number fails the Luhn checksum, a made-up IBAN fails
 * mod-97, and phone numbers are parsed by libphonenumber rather than matched by a loose regex.
 */
import { isIPv4, isIPv6 } from "node:net";
import { type CountryCode, findPhoneNumbersInText } from "libphonenumber-js/max";
import type { Finding } from "./base.js";

const EMAIL =
  /(?<![\w.+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![\w-])/g;
const CARD = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;
// Issuer prefixes: Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay.
const CARD_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5|4[4-9]|22)|35|30[0-5]|36|38|62)/;
const SSN = /(?<![\d-])(\d{3})([- ])(\d{2})\2(\d{4})(?![\d-])/g;
const IBAN = /\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30})\b/g;
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const IPV6 = /(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g;

// biome-ignore format: a table reads better on few lines
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AT: 20, BE: 16, BG: 22, BH: 22, BR: 29, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18,
  EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GI: 23, GR: 27, HR: 21, HU: 28, IE: 22, IL: 23, IS: 26,
  IT: 27, KW: 30, KZ: 20, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PK: 24,
  PL: 28, PT: 25, QA: 29, RO: 24, SA: 24, SE: 24, SI: 19, SK: 24, SM: 27, TR: 26, UA: 29,
};

export function luhn(digits: string): boolean {
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d > 4 ? d * 2 - 9 : d * 2;
    total += d;
  }
  return total % 10 === 0;
}

export function ibanValid(raw: string): boolean {
  const iban = raw.replaceAll(" ", "");
  if (IBAN_LENGTHS[iban.slice(0, 2)] !== iban.length) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = Number.parseInt(ch, 36);
    for (const digit of String(v)) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

export function ssnValid(area: string, group: string, serial: string): boolean {
  return area !== "000" && area !== "666" && !area.startsWith("9") && group !== "00" && serial !== "0000";
}

export function* findPatterns(text: string, phoneRegion = "US"): Generator<Finding> {
  for (const m of text.matchAll(EMAIL)) {
    yield {
      entity: "EMAIL",
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
      score: 1,
      detector: "pattern",
    };
  }
  for (const m of text.matchAll(CARD)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && CARD_PREFIX.test(digits) && luhn(digits)) {
      yield {
        entity: "CREDIT_CARD",
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        score: 1,
        detector: "pattern",
      };
    }
  }
  for (const m of text.matchAll(SSN)) {
    if (ssnValid(m[1] ?? "", m[3] ?? "", m[4] ?? "")) {
      yield {
        entity: "US_SSN",
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        score: 0.95,
        detector: "pattern",
      };
    }
  }
  for (const m of text.matchAll(IBAN)) {
    const candidate = (m[1] ?? "").trimEnd();
    if (ibanValid(candidate)) {
      yield {
        entity: "IBAN",
        start: m.index,
        end: m.index + candidate.length,
        text: candidate,
        score: 1,
        detector: "pattern",
      };
    }
  }
  for (const m of text.matchAll(IPV4)) {
    if (isIPv4(m[0])) {
      yield {
        entity: "IP_ADDRESS",
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        score: 0.9,
        detector: "pattern",
      };
    }
  }
  for (const m of text.matchAll(IPV6)) {
    const v = m[0];
    if ((v.match(/:/g)?.length ?? 0) >= 2 && /[0-9A-Fa-f]/.test(v) && isIPv6(v)) {
      yield {
        entity: "IP_ADDRESS",
        start: m.index,
        end: m.index + v.length,
        text: v,
        score: 0.9,
        detector: "pattern",
      };
    }
  }
  let phones: ReturnType<typeof findPhoneNumbersInText> = [];
  try {
    phones = findPhoneNumbersInText(text, { defaultCountry: phoneRegion as CountryCode });
  } catch {
    phones = [];
  }
  for (const p of phones) {
    if (!p.number.isValid()) continue;
    yield {
      entity: "PHONE",
      start: p.startsAt,
      end: p.endsAt,
      text: text.slice(p.startsAt, p.endsAt),
      score: 0.9,
      detector: "pattern",
    };
  }
}
