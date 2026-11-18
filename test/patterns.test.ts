import { describe, expect, it } from "vitest";
import { type Finding, resolveOverlaps } from "../src/detectors/base.js";
import { findPatterns, ibanValid, luhn } from "../src/detectors/patterns.js";
import { findSecrets } from "../src/detectors/secrets.js";

const entities = (text: string) => resolveOverlaps(findPatterns(text)).map((f) => [f.entity, f.text]);

describe("patterns", () => {
  it.each(["jane.doe@example.com", "j+tag@mail.co.uk", "A.B_C-d@sub.domain.io"])("finds email %s", (e) => {
    expect(entities(`write to ${e} today`)).toEqual([["EMAIL", e]]);
  });

  it("ignores email lookalikes", () => {
    expect(entities("use @decorator and user@localhost")).toEqual([]);
  });

  it.each(["(415) 555-0132", "+1 415-555-0132", "+44 20 7946 0958", "+91 98765 43210"])(
    "finds phone %s",
    (n) => {
      expect(entities(`call ${n} now`)).toEqual([["PHONE", n]]);
    },
  );

  it("ignores phone lookalikes", () => {
    expect(entities("order 12345, version 2.4.1, on 2026-11-17, total $1,234.56")).toEqual([]);
  });

  it.each(["4111 1111 1111 1111", "4111-1111-1111-1111", "5555555555554444", "378282246310005"])(
    "finds card %s",
    (card) => {
      expect(entities(`card ${card} please`)).toEqual([["CREDIT_CARD", card]]);
    },
  );

  it("ignores numbers failing Luhn", () => {
    expect(luhn("4111111111111112")).toBe(false);
    expect(entities("tracking 4111 1111 1111 1112").map(([e]) => e)).not.toContain("CREDIT_CARD");
  });

  it.each(["123-45-6789", "123 45 6789"])("finds SSN %s", (ssn) => {
    expect(entities(`SSN ${ssn}.`)).toEqual([["US_SSN", ssn]]);
  });

  it.each(["000-12-3456", "666-12-3456", "912-34-5678", "123-00-4567", "123-45-0000"])(
    "skips never-issued SSN %s",
    (ssn) => {
      expect(entities(`SSN ${ssn}`).map(([e]) => e)).not.toContain("US_SSN");
    },
  );

  it("validates IBANs", () => {
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("GB82WEST12345698765433")).toBe(false);
    expect(entities("IBAN DE89 3704 0044 0532 0130 00 thanks")).toEqual([
      ["IBAN", "DE89 3704 0044 0532 0130 00"],
    ]);
  });

  it("finds IP addresses", () => {
    expect(entities("from 203.0.113.7 and 2001:db8::8a2e:370:7334")).toEqual([
      ["IP_ADDRESS", "203.0.113.7"],
      ["IP_ADDRESS", "2001:db8::8a2e:370:7334"],
    ]);
  });

  it("ignores IP lookalikes", () => {
    expect(entities("version 1.2.3, 999.1.1.1, at 12:30:45, std::vector")).toEqual([]);
  });
});

describe("secrets", () => {
  it.each([
    [`sk-proj-${"a1B2".repeat(12)}`, "openai"],
    [`sk-ant-api03-${"x9Y8".repeat(12)}`, "anthropic"],
    ["AKIAIOSFODNN7EXAMPLE", "aws_access_key"],
    [`ghp_${"a".repeat(36)}`, "github"],
    ["xoxb-1234567890-abcdefghij", "slack"],
    // Built from parts so secret scanners don't flag this fake key.
    [["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"), "stripe"],
    [["AIza", "SyA-1234567890abcdefghijklmnopqrstu"].join(""), "google_api_key"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt"],
  ])("finds %s", (text, kind) => {
    expect([...findSecrets(`config: ${text} end`)].map((f) => [f.detector, f.text])).toEqual([
      [`secret:${kind}`, text],
    ]);
  });

  it("finds private key blocks", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\n-----END RSA PRIVATE KEY-----";
    expect([...findSecrets(`here:\n${key}\n`)].map((f) => f.detector)).toEqual(["secret:private_key"]);
  });

  it("finds only the password in a connection string", () => {
    const found = [...findSecrets("DATABASE_URL=postgres://app:s3cr3tPassw0rd@db:5432/app")];
    expect(found.map((f) => f.text)).toEqual(["s3cr3tPassw0rd"]);
    expect(found[0]?.start).toBe("DATABASE_URL=postgres://app:".length);
  });

  it("needs randomness for generic assignments and skips placeholders", () => {
    expect([...findSecrets('api_key = "Zq8#mL2!vR9x"')].map((f) => f.text)).toEqual(["Zq8#mL2!vR9x"]);
    expect([...findSecrets("password = aaaaaaaaaa")]).toEqual([]);
    const placeholders = "api_key=<your-key-here> token: $" + "{API_TOKEN} secret: xxxxxxxxxx";
    expect([...findSecrets(placeholders)]).toEqual([]);
  });
});

it("prefers checksummed formats where findings overlap", () => {
  const a: Finding = {
    entity: "PHONE",
    start: 0,
    end: 19,
    text: "4111 1111 1111 1111",
    score: 0.9,
    detector: "pattern",
  };
  const b: Finding = { ...a, entity: "CREDIT_CARD", score: 1 };
  const c: Finding = { entity: "PERSON", start: 25, end: 30, text: "Alice", score: 0.9, detector: "ner" };
  expect(resolveOverlaps([a, b, c])).toEqual([b, c]);
});

it("merges WordPiece continuations into one word", async () => {
  const { mergeWordPieces } = await import("../src/detectors/models.js");
  const merged = mergeWordPieces([
    { label: "B-PER", score: 0.99, start: 0, end: 1 },
    { label: "O", score: 0.6, start: 1, end: 8, continuation: true },
    { label: "I-PER", score: 0.98, start: 9, end: 15 },
  ]);
  expect(merged).toEqual([
    { label: "B-PER", score: 0.99, start: 0, end: 8 },
    { label: "I-PER", score: 0.98, start: 9, end: 15 },
  ]);
});

describe("street addresses", () => {
  const addresses = (text: string) =>
    [...findPatterns(text)].filter((f) => f.entity === "ADDRESS").map((f) => f.text);

  it("finds a street address with its unit, city, state and ZIP", () => {
    expect(addresses("Ship to 742 Evergreen Terrace, Springfield. Call first.")).toEqual([
      "742 Evergreen Terrace, Springfield",
    ]);
    expect(addresses("Unit at 55 W Elm St, Apt 4B, Chicago, IL 60610")).toEqual([
      "55 W Elm St, Apt 4B, Chicago, IL 60610",
    ]);
    expect(addresses("Office: 1600 Pennsylvania Ave NW, Washington, DC 20500.")).toEqual([
      "1600 Pennsylvania Ave NW, Washington, DC 20500",
    ]);
    expect(addresses("Meet at 15 Martin Luther King Jr Blvd.")).toEqual(["15 Martin Luther King Jr Blvd"]);
  });

  it("doesn't take the next sentence's first word as a city", () => {
    expect(addresses("moved to 17 Willow Court, Brookhaven, Call me")).toEqual([
      "17 Willow Court, Brookhaven",
    ]);
  });

  it("leaves numbers followed by ordinary capitalized words alone", () => {
    for (const text of [
      "We sold 300 Blue Widgets at the Main Event.",
      "Exit 42 Highway closures are expected.",
      "Step 3 Drive the car to the dealer.",
      "Chapter 12 Way Forward explains the plan.",
      "I live on Main Street.",
    ]) {
      expect(addresses(text), text).toEqual([]);
    }
  });
});
