/**
 * Tiny, dependency-free text helpers used by the keyword half of hybrid recall.
 *
 * Keeping these here (rather than reaching for a stemmer / BM25 library) is a
 * deliberate "simple" choice: a maintainer can read the whole scoring story in
 * one screen, and the lexical signal only needs to be *good enough* to rescue
 * the keyword-heavy queries that pure embeddings miss ("what's the dog's name?").
 */

const WORD_RE = /[\p{L}\p{N}]+/gu;

// Short on purpose. Dropping too many tokens hurts recall on terse queries like
// "where do they live", so we only strip the highest-frequency function words.
export const STOPWORDS: ReadonlySet<string> = new Set(
  `a an the this that these those is are was were be been being am
   i me my we our you your he she it they them his her its their
   of to in on at for with and or but if then than so as by from into
   do does did done has have had having will would can could should
   what when where who whom which why how about not no yes`.split(/\s+/),
);

export function tokenize(text: string, dropStopwords = true): string[] {
  if (!text) return [];
  const toks = text.toLowerCase().match(WORD_RE) ?? [];
  return dropStopwords ? toks.filter((t) => !STOPWORDS.has(t)) : toks;
}

export function tokenSet(text: string, dropStopwords = true): Set<string> {
  return new Set(tokenize(text, dropStopwords));
}

/** Fraction of query tokens present in `text`: |q ∩ t| / |q|. Range [0,1]. */
export function keywordOverlap(qset: Set<string>, text: string): number {
  if (qset.size === 0) return 0;
  const tset = tokenSet(text);
  if (tset.size === 0) return 0;
  let hit = 0;
  for (const t of qset) if (tset.has(t)) hit++;
  return hit / qset.size;
}
