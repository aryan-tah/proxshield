/** API keys, tokens and private keys, found by their published formats. */
import type { Finding } from "./base.js";

// [name, pattern, group]. Group 0 is the whole match.
const RULES: [string, RegExp, number][] = [
  ["anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,}/g, 0],
  ["openai", /\bsk-(?:proj-|svcacct-|admin-)?(?!ant-)[A-Za-z0-9_-]{20,}/g, 0],
  ["aws_access_key", /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, 0],
  ["github", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, 0],
  ["gitlab", /\bglpat-[A-Za-z0-9_-]{20,}/g, 0],
  ["slack", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 0],
  ["stripe", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, 0],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}/g, 0],
  ["huggingface", /\bhf_[A-Za-z0-9]{30,}/g, 0],
  ["npm", /\bnpm_[A-Za-z0-9]{36}\b/g, 0],
  ["sendgrid", /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, 0],
  ["private_key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g, 0],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 0],
  [
    "connection_string",
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:/@]+:([^\s@/]{3,})@/g,
    1,
  ],
  [
    "assignment",
    /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']?([^\s"',;]{8,})/gi,
    1,
  ],
];

/** Values that look like placeholders, not real secrets. */
const PLACEHOLDER = /^(?:x+|\*+|<[^>]+>|\$\{?[A-Z_]+\}?|your[_-].*|changeme|example.*|\[[A-Z_]+_\d+\])$/i;

export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

export function* findSecrets(text: string): Generator<Finding> {
  for (const [name, pattern, group] of RULES) {
    for (const m of text.matchAll(pattern)) {
      const value = m[group];
      if (value === undefined || PLACEHOLDER.test(value)) continue;
      // Generic "password = ..." matches need some randomness to count.
      if (name === "assignment" && entropy(value) < 2.5) continue;
      const start = group === 0 ? m.index : m.index + m[0].lastIndexOf(value);
      yield {
        entity: "SECRET",
        start,
        end: start + value.length,
        text: value,
        score: 1,
        detector: `secret:${name}`,
      };
    }
  }
}
