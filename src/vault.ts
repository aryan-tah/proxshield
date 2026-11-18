/**
 * Placeholders: swap sensitive values out of a request and back into its response. A vault
 * lives for one request. It's never logged, stored or shared between requests.
 */

export const PLACEHOLDER = /\[([A-Z][A-Z0-9_]*?)_(\d+)\]/g;

function normalize(entity: string, value: string): string {
  if (entity === "EMAIL") return value.trim().toLowerCase();
  if (entity === "PHONE" || entity === "CREDIT_CARD" || entity === "US_SSN") return value.replace(/\D/g, "");
  if (entity === "IBAN") return value.replaceAll(" ", "").toUpperCase();
  return value.split(/\s+/).filter(Boolean).join(" ");
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type Escape = (value: string) => string;

/** Escape a value for insertion inside a JSON string literal (streamed tool arguments). */
export const jsonStringEscape: Escape = (value) => JSON.stringify(value).slice(1, -1);

export class Vault {
  private readonly byValue = new Map<string, string>();
  private readonly originals = new Map<string, string>();
  private readonly restorable = new Set<string>();
  private readonly counters = new Map<string, number>();
  private readonly reserved = new Set<string>();
  private pattern: RegExp | null = null;

  /** Remember placeholder-looking text the user typed, so it's never reused or replaced. */
  reserve(text: string): void {
    for (const m of text.matchAll(PLACEHOLDER)) this.reserved.add(m[0]);
  }

  placeholder(entity: string, value: string, restorable: boolean): string {
    const key = `${entity}\u0000${normalize(entity, value)}`;
    let token = this.byValue.get(key);
    if (token === undefined) {
      do {
        const n = (this.counters.get(entity) ?? 0) + 1;
        this.counters.set(entity, n);
        token = `[${entity}_${n}]`;
      } while (this.reserved.has(token));
      this.byValue.set(key, token);
      this.originals.set(token, value);
    }
    if (restorable && !this.restorable.has(token)) {
      this.restorable.add(token);
      this.pattern = null;
    }
    return token;
  }

  get size(): number {
    return this.originals.size;
  }

  /** Every form a restorable placeholder might come back in: `[EMAIL_1]` and bare `EMAIL_1`. */
  get tokens(): string[] {
    return [...this.restorable].flatMap((t) => [t, t.slice(1, -1)]);
  }

  private regex(): RegExp | null {
    if (this.restorable.size === 0) return null;
    if (this.pattern === null) {
      // Longest first, so [PERSON_12] wins over [PERSON_1]. Bare forms need word boundaries.
      const ordered = [...this.restorable].sort((a, b) => b.length - a.length);
      const bracketed = ordered.map(escapeRegExp).join("|");
      const bare = ordered.map((t) => escapeRegExp(t.slice(1, -1))).join("|");
      this.pattern = new RegExp(`${bracketed}|(?<![\\w\\[])(?:${bare})(?![\\w\\]])`, "g");
    }
    return this.pattern;
  }

  restore(text: string, escapeValue?: Escape): string {
    const pattern = this.regex();
    if (pattern === null || !text) return text;
    return text.replace(pattern, (match) => {
      const token = match.startsWith("[") ? match : `[${match}]`;
      const value = this.originals.get(token) ?? match;
      return escapeValue ? escapeValue(value) : value;
    });
  }

  /** Restore every string inside a parsed JSON value (tool-call arguments). */
  restoreJson(value: unknown): unknown {
    if (typeof value === "string") return this.restore(value);
    if (Array.isArray(value)) return value.map((v) => this.restoreJson(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.restoreJson(v)]));
    }
    return value;
  }
}

/**
 * Restores placeholders in streamed text, where one can arrive split across chunks. Text that
 * might be the start of a placeholder is held back until the next chunk shows whether it is
 * one. `finish()` returns whatever is still held.
 */
export class StreamRestorer {
  private buf = "";

  constructor(
    private readonly vault: Vault,
    private readonly escapeValue?: Escape,
  ) {}

  feed(chunk: string): string {
    this.buf += chunk;
    const tokens = this.vault.tokens;
    if (tokens.length === 0) {
      const out = this.buf;
      this.buf = "";
      return out;
    }
    const hold = this.holdFrom(tokens);
    const out = this.buf.slice(0, hold);
    this.buf = this.buf.slice(hold);
    return this.vault.restore(out, this.escapeValue);
  }

  finish(): string {
    const out = this.buf;
    this.buf = "";
    return this.vault.restore(out, this.escapeValue);
  }

  private holdFrom(tokens: string[]): number {
    const longest = Math.max(...tokens.map((t) => t.length));
    const buf = this.buf;
    for (let i = Math.max(0, buf.length - longest); i < buf.length; i++) {
      const tail = buf.slice(i);
      for (const token of tokens) {
        const bare = !token.startsWith("[");
        if (bare && i > 0 && /[\w[]/.test(buf[i - 1] ?? "")) continue;
        // A complete bare token is held too: the next chunk might extend it (PERSON_1 → PERSON_12).
        if (token.startsWith(tail) && (tail.length < token.length || bare)) return i;
      }
    }
    return buf.length;
  }
}
