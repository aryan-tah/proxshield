/** LLM Guard's risk score: -1 (far below the threshold) to 1 (certain), 0 at the threshold. */
export function riskScore(score: number, threshold: number): number {
  let risk: number;
  if (score > threshold) risk = threshold < 1 ? (score - threshold) / (1 - threshold) : 1;
  else risk = threshold > 0 ? (score - threshold) / threshold : 0;
  return Math.round(Math.max(-1, Math.min(1, risk)) * 10) / 10;
}

/** Lakera Guard's confidence levels. */
export function lakeraLevel(score: number): string {
  if (score >= 0.95) return "l1_confident";
  if (score >= 0.85) return "l2_very_likely";
  if (score >= 0.7) return "l3_likely";
  if (score >= 0.5) return "l4_less_likely";
  return "l5_unlikely";
}
