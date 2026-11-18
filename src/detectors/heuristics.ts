/**
 * Prompt-injection heuristics. They catch the blunt, high-confidence cases cheaply and explain
 * themselves ("override instruction", "hidden Unicode tags"). The classifier model catches
 * paraphrases. The final score is the higher of the two.
 */

// Unicode "tag" characters (U+E0000-U+E007F) render as nothing but carry ASCII. They're used to
// smuggle instructions past people reading the text ("ASCII smuggling").
export const TAGS = /[\u{E0000}-\u{E007F}]/gu;
export const ZERO_WIDTH = /\u200b|\u200c|\u200d|\u2060|\ufeff|\u180e/g;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;

// Cyrillic and Greek letters that look like Latin ones. NFKC folds full-width and styled
// letters but not these.
const FROM = "аеорсухіјѕԁɡһӏԛԝАВЕКМНОРСТХІЈЅοαενιρτκχΑΒΕΗΙΚΜΝΟΡΤΧΥΖ";
const TO = "aeopcyxijsdghlqwABEKMHOPCTXIJSoaeviptkxABEHIKMNOPTXYZ";
const HOMOGLYPHS = new Map([...FROM].map((c, i) => [c, TO[i] ?? c]));

const VERB = `(?:ignore|disregard|forget|override|bypass|skip|drop|abandon|neglect)`;
const SCOPE = String.raw`(?:all\s+|any\s+|the\s+|your\s+|my\s+|these\s+|those\s+)*`;
const WHEN = `(?:previous|prior|above|earlier|preceding|initial|original|system|existing|foregoing)`;
const WHAT = `(?:instructions?|prompts?|rules?|directions?|directives?|guidelines?|context|messages?|commands?|constraints?|tasks?|assignments?|orders?|information|conversation)`;

const RULES: [string, number, RegExp][] = [
  [
    "override_instructions",
    0.97,
    new RegExp(String.raw`\b${VERB}\s+${SCOPE}(?:of\s+)?${SCOPE}${WHEN}\s+${WHAT}`, "i"),
  ],
  ["new_instructions", 0.93, /\b(?:new|updated|real|actual|revised)\s+(?:system\s+)?instructions?\s*[:-]/i],
  [
    "role_marker",
    0.95,
    /(?:<\|im_start\|>\s*system|<\|system\|>|\[\/?INST\]|<<SYS>>|^\s*#{2,}\s*system\b|^\s*system\s*(?:prompt|message|override)?\s*:|\bBEGIN\s+SYSTEM\s+PROMPT\b)/im,
  ],
  [
    "prompt_extraction",
    0.92,
    /\b(?:reveal|print|show|repeat|output|display|leak|tell\s+me|give\s+me|what\s+(?:is|are))\s+(?:me\s+)?(?:your|the)\s+(?:(?:full|entire|original|initial|hidden|secret)\s+)*(?:system\s+prompt|system\s+message|initial\s+prompt|developer\s+message|prompt\s+texts?)|\b(?:reveal|print|show|repeat|output|display|leak|tell\s+me|give\s+me|what\s+(?:is|are))\s+(?:me\s+)?(?:your|the)\s+(?:full\s+|entire\s+)?(?:original|initial|hidden|secret|system|real)\s+instructions|\bshow\s+(?:me\s+)?(?:all\s+)?your\s+prompt\s+texts?|\bwhat\s+was\s+written\s+(?:at\s+the\s+beginning|above)\s+(?:of\s+)?(?:this|the)\s+prompt/i,
  ],
  [
    "jailbreak_persona",
    0.9,
    /\b(?:you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as|pretend\s+to\s+be|roleplay\s+as)\s+(?:an?\s+)?(?:DAN\b|unrestricted|unfiltered|jailbroken|evil|uncensored|developer\s+mode)|\bdo\s+anything\s+now\b|\bdeveloper\s+mode\s+(?:enabled|on)\b/i,
  ],
  ["exfiltration_link", 0.85, /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]+\?[^)\s]*=[^)\s]*\)/i],
  [
    "exfiltration_instruction",
    0.88,
    /\b(?:send|post|forward|upload|exfiltrate|email|leak)\s+(?:all\s+|the\s+|this\s+|any\s+|every\s+)*(?:\w+\s+){0,3}(?:data|conversation|messages?|history|secrets?|keys?|credentials?|passwords?|tokens?)\s+(?:\w+\s+){0,3}to\s+(?:https?:\/\/|\S+@\S+)/i,
  ],
];

export interface Heuristics {
  score: number;
  reasons: string[];
  /** Text decoded from Unicode tag characters, if any. It's scanned too. */
  hiddenText: string;
}

export function decodeTags(text: string): string {
  let out = "";
  for (const m of text.matchAll(TAGS)) {
    const c = (m[0].codePointAt(0) ?? 0) - 0xe0000;
    if (c >= 0x20 && c < 0x7f) out += String.fromCharCode(c);
  }
  return out;
}

/** Fold lookalike characters and strip invisible ones before matching. */
export function normalize(text: string): string {
  const visible = text.replace(TAGS, "").replace(BIDI, "").replace(ZERO_WIDTH, "").normalize("NFKC");
  let out = "";
  for (const c of visible) out += HOMOGLYPHS.get(c) ?? c;
  return out;
}

export function check(text: string): Heuristics {
  const out: Heuristics = { score: 0, reasons: [], hiddenText: "" };
  const hidden = decodeTags(text);
  if (hidden.trim()) {
    out.hiddenText = hidden;
    out.reasons.push("hidden_unicode_tags");
    out.score = 0.99;
  }
  if ((text.match(ZERO_WIDTH)?.length ?? 0) >= 10) {
    out.reasons.push("many_invisible_characters");
    out.score = Math.max(out.score, 0.6);
  }
  for (const target of [normalize(text), hidden]) {
    if (!target) continue;
    for (const [name, score, pattern] of RULES) {
      if (!out.reasons.includes(name) && pattern.test(target)) {
        out.reasons.push(name);
        out.score = Math.max(out.score, score);
      }
    }
  }
  return out;
}
