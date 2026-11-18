import { expect, it } from "vitest";
import { jsonStringEscape, StreamRestorer, Vault } from "../src/vault.js";

function make(): Vault {
  const v = new Vault();
  expect(v.placeholder("EMAIL", "Jane@Example.com", true)).toBe("[EMAIL_1]");
  expect(v.placeholder("PERSON", "Jane Doe", true)).toBe("[PERSON_1]");
  expect(v.placeholder("SECRET", "sk-abc", false)).toBe("[SECRET_1]");
  return v;
}

it("gives the same value the same placeholder", () => {
  const v = make();
  expect(v.placeholder("EMAIL", "jane@example.com ", true)).toBe("[EMAIL_1]");
  expect(v.placeholder("EMAIL", "bob@example.com", true)).toBe("[EMAIL_2]");
  expect(v.placeholder("PHONE", "(415) 555-0132", true)).toBe(v.placeholder("PHONE", "415.555.0132", true));
});

it("restores bracketed and bare placeholders", () => {
  const v = make();
  expect(v.restore("Mail [EMAIL_1] for PERSON_1, not PERSON_10 or [SECRET_1].")).toBe(
    "Mail Jane@Example.com for Jane Doe, not PERSON_10 or [SECRET_1].",
  );
});

it("leaves placeholders the user typed alone", () => {
  const v = new Vault();
  v.reserve("Fill in [EMAIL_1] in the template");
  expect(v.placeholder("EMAIL", "a@b.co", true)).toBe("[EMAIL_2]");
  expect(v.restore("template [EMAIL_1], value [EMAIL_2]")).toBe("template [EMAIL_1], value a@b.co");
});

it("restores inside parsed JSON", () => {
  const v = make();
  expect(v.restoreJson({ to: "[EMAIL_1]", cc: ["PERSON_1"], n: 3 })).toEqual({
    to: "Jane@Example.com",
    cc: ["Jane Doe"],
    n: 3,
  });
});

const TEXT = "Hi [PERSON_1], I emailed [EMAIL_1] and PERSON_1 again. [SECRET_1] stays. [EMAIL_9] too.";
const EXPECTED =
  "Hi Jane Doe, I emailed Jane@Example.com and Jane Doe again. [SECRET_1] stays. [EMAIL_9] too.";

it.each([1, 2, 3, 5, 7, 11])("restores streams split every %i characters", (size) => {
  const r = new StreamRestorer(make());
  let out = "";
  for (let i = 0; i < TEXT.length; i += size) out += r.feed(TEXT.slice(i, i + size));
  expect(out + r.finish()).toBe(EXPECTED);
});

it("holds back as little as possible", () => {
  const r = new StreamRestorer(make());
  expect(r.feed("Hello [EM")).toBe("Hello ");
  expect(r.feed("AIL_1] there")).toBe("Jane@Example.com there");
  expect(r.feed("[not a placeholder]")).toBe("[not a placeholder]");
});

it("passes streams through when nothing was redacted", () => {
  expect(new StreamRestorer(new Vault()).feed("[EMAIL_")).toBe("[EMAIL_");
});

it("escapes values restored into streamed JSON", () => {
  const v = new Vault();
  v.placeholder("PERSON", 'Dwayne "The Rock" Johnson', true);
  const r = new StreamRestorer(v, jsonStringEscape);
  const out = r.feed('{"name": "[PERS') + r.feed('ON_1]"}') + r.finish();
  expect(JSON.parse(out)).toEqual({ name: 'Dwayne "The Rock" Johnson' });
});
