/**
 * Token budgeting helper.
 *
 * The recall contract asks us to respect `max_tokens` approximately ("don't blow
 * past it by 2x"). The ~4-chars-per-token heuristic is well within tolerance for
 * English prose and avoids a heavy tokenizer dependency.
 */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}
