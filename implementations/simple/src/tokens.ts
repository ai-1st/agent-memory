/**
 * Token budgeting. The /recall contract asks us to respect `max_tokens`
 * approximately ("don't blow past it by 2x"). The ~4-chars-per-token heuristic
 * is comfortably within tolerance for English prose and keeps us free of a heavy
 * tokenizer dependency — in keeping with the "simple" brief.
 */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}
