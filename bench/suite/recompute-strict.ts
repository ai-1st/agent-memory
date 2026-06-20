#!/usr/bin/env -S npx tsx
/**
 * Backfill the strict-floor columns (accuracyStrict / lenientPasses / strictFloor)
 * onto already-written cards, and report where the lenient passes cluster. Cards
 * store per-probe `score`, so this needs no re-run.
 *
 *   npx tsx bench/suite/recompute-strict.ts
 *
 * A "lenient pass" = the judge marked the probe correct but scored it below the
 * floor (0.8) — i.e. the answer was only partially conveyed. These inflate the
 * headline accuracy; this surfaces them.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STRICT_FLOOR } from "./runner";
import type { Card } from "./types";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const round = (n: number, d = 3): number => Math.round(n * 10 ** d) / 10 ** d;
const DEV = /-(smoke|validate|gen|trace)\.json$/; // dev artifacts, skip
const isGood = (label: string): boolean => /simple|maxxed|opinionated/.test(label);

function main(): void {
  const dir = join(REPO, "bench", "results", "suite");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !DEV.test(f));

  const byCat: Record<string, { lenient: number; pass: number }> = {};
  let goodPass = 0;
  let goodLenient = 0;

  for (const f of files.sort()) {
    const p = join(dir, f);
    const card = JSON.parse(readFileSync(p, "utf8")) as Card;
    const rs = card.results ?? [];
    const pass = rs.filter((r) => r.correct).length;
    const strict = rs.filter((r) => r.correct && r.score >= STRICT_FLOOR).length;
    const lenient = pass - strict;
    card.accuracyStrict = rs.length ? round(strict / rs.length) : 0;
    card.lenientPasses = lenient;
    card.strictFloor = STRICT_FLOOR;
    writeFileSync(p, JSON.stringify(card, null, 2));

    if (lenient > 0 || pass !== strict) {
      process.stderr.write(
        `${f}: acc ${Math.round(card.accuracy * 100)}% -> strict ${Math.round(card.accuracyStrict * 100)}% (${lenient} lenient)\n`,
      );
    }
    if (isGood(card.label)) {
      goodPass += pass;
      goodLenient += lenient;
      for (const r of rs) {
        if (!r.correct) continue;
        byCat[r.category] ??= { lenient: 0, pass: 0 };
        byCat[r.category].pass++;
        if (r.score < STRICT_FLOOR) byCat[r.category].lenient++;
      }
    }
  }

  process.stderr.write(
    `\nGOOD builds (simple/maxxed/opinionated): ${goodLenient}/${goodPass} passes are lenient (${round((100 * goodLenient) / Math.max(1, goodPass), 1)}%)\n`,
  );
  const rows = Object.entries(byCat)
    .filter(([, v]) => v.lenient > 0)
    .sort((a, b) => b[1].lenient - a[1].lenient);
  for (const [cat, v] of rows) {
    process.stderr.write(`  ${cat}: ${v.lenient}/${v.pass} lenient\n`);
  }
}

main();
