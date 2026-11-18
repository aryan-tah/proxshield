import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { actionFor, loadConfig } from "../src/config.js";

const file = (toml: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "proxshield-")), "proxshield.toml");
  writeFileSync(path, toml);
  return path;
};

it("has safe defaults", () => {
  const cfg = loadConfig(undefined, {});
  expect(cfg.entities.EMAIL).toBe("redact");
  expect(cfg.entities.SECRET).toBe("mask");
  expect(cfg.injectionThreshold).toBe(0.9);
  expect(cfg.apiKeys.size).toBe(0);
});

it("reads TOML and environment variables", () => {
  const path = file(`
[pii]
model = "privacy-filter"
phone_region = "gb"
[pii.entities]
LOCATION = "redact"
CREDIT_CARD = "block"
[[pii.custom]]
name = "TICKET"
pattern = 'TCK-\\d+'
[injection]
threshold = 0.8
roles = ["tool"]
[upstream]
openai_base_url = "http://localhost:11434/v1/"
[server]
block_mode = "refusal"
`);
  const cfg = loadConfig(path, { PROXSHIELD_API_KEYS: "a, b", PROXSHIELD_ANTHROPIC_API_KEY: "sk-ant-x" });
  expect(cfg.piiModel).toBe("privacy-filter");
  expect(cfg.phoneRegion).toBe("GB");
  expect(cfg.entities.LOCATION).toBe("redact");
  expect(actionFor(cfg, "CREDIT_CARD")).toBe("block");
  expect(actionFor(cfg, "TICKET")).toBe("redact");
  expect(cfg.custom[0]?.pattern.test("TCK-12")).toBe(true);
  expect(cfg.injectionThreshold).toBe(0.8);
  expect([...cfg.injectionRoles]).toEqual(["tool"]);
  expect(cfg.openaiBaseUrl).toBe("http://localhost:11434/v1");
  expect(cfg.blockMode).toBe("refusal");
  expect([...cfg.apiKeys]).toEqual(["a", "b"]);
  expect(cfg.anthropicApiKey).toBe("sk-ant-x");
});

it.each([
  ['[pii.entities]\nEMAIL = "hide"', "pii.entities.EMAIL"],
  ['[pii.entities]\nemail = "redact"', "UPPER_SNAKE_CASE"],
  ['[[pii.custom]]\nname = "X"\npattern = "("', "pii.custom[0].pattern"],
  ['[pii]\nmodel = "gpt"', "pii.model"],
  ['[server]\nblock_mode = "drop"', "block_mode"],
  ['[output]\npii = "block"', "output.pii"],
])("rejects %s", (toml, message) => {
  expect(() => loadConfig(file(toml), {})).toThrow(message);
});
