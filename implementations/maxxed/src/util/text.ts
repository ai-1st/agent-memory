/**
 * Lightweight, dependency-free text utilities used across the hybrid retrieval
 * pipeline: tokenization for lexical scoring, BM25-ish term stats, and small
 * helpers. Kept pure and offline so unit tests run with no network.
 */

const WORD_RE = /[\p{L}\p{N}]+/gu;

// Small hand-picked stopword set. Deliberately short: dropping too many tokens
// hurts lexical recall on terse queries like "where do they live".
export const STOPWORDS: ReadonlySet<string> = new Set(
  `a an the this that these those is are was were be been being am
   i me my we our you your he she it they them his her its their
   of to in on at for with and or but if then than so as by from into
   do does did done has have had having will would can could should
   what when where who whom which why how about not no yes a's it's i'm`
    .toLowerCase()
    .split(/\s+/),
);

export function tokenize(text: string, dropStopwords = true): string[] {
  if (!text) return [];
  const toks = (text.toLowerCase().match(WORD_RE) ?? []) as string[];
  return dropStopwords ? toks.filter((t) => !STOPWORDS.has(t)) : toks;
}

export function tokenSet(text: string, dropStopwords = true): Set<string> {
  return new Set(tokenize(text, dropStopwords));
}

/** Fraction of query tokens present in `text`: |q ∩ t| / |q|. */
export function overlap(qset: Set<string>, text: string): number {
  if (qset.size === 0) return 0;
  const tset = tokenSet(text);
  if (tset.size === 0) return 0;
  let n = 0;
  for (const t of qset) if (tset.has(t)) n++;
  return n / qset.size;
}

/** Cosine similarity of two equal-length dense vectors. */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const round4 = (x: number): number => Math.round(x * 10000) / 10000;

/** Collapse whitespace and clip to a max length for snippets/citations. */
export function snippet(text: string, max = 240): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
