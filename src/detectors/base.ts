export interface Finding {
  /** EMAIL, PHONE, PERSON, SECRET, ... or a custom name from the config. */
  entity: string;
  start: number;
  end: number;
  text: string;
  score: number;
  /** Which detector found it: `pattern`, `secret:github`, `ner`, `privacy-filter`, `custom`. */
  detector: string;
}

/** When findings overlap, the higher priority wins. Checksummed formats beat loose ones; patterns beat models. */
export const PRIORITY: Readonly<Record<string, number>> = {
  SECRET: 100,
  CREDIT_CARD: 90,
  IBAN: 85,
  US_SSN: 80,
  EMAIL: 70,
  IP_ADDRESS: 60,
  PHONE: 50,
  ACCOUNT_NUMBER: 45,
  ADDRESS: 40,
  URL: 30,
  DATE: 25,
  PERSON: 20,
  ORGANIZATION: 15,
  LOCATION: 10,
};
const CUSTOM_PRIORITY = 75;

/** Keep the highest-priority finding wherever findings overlap; ties go to the longer one. */
export function resolveOverlaps(findings: Iterable<Finding>): Finding[] {
  const rank = (f: Finding): [number, number, number] => [
    PRIORITY[f.entity] ?? CUSTOM_PRIORITY,
    f.end - f.start,
    f.score,
  ];
  const sorted = [...findings].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return rb[0] - ra[0] || rb[1] - ra[1] || rb[2] - ra[2];
  });
  const kept: Finding[] = [];
  for (const f of sorted) {
    if (kept.every((k) => f.end <= k.start || f.start >= k.end)) kept.push(f);
  }
  return kept.sort((a, b) => a.start - b.start);
}
