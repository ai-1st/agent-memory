#!/usr/bin/env -S npx tsx
/**
 * Re-stamp est_usd on already-written cards using the model-aware price table.
 *
 *   npx tsx bench/suite/restamp-cost.ts <model> <glob-substring>
 *   npx tsx bench/suite/restamp-cost.ts claude-haiku-4-5 -haiku
 *
 * Cards store raw token counts, so cost can be recomputed without re-running the
 * suite. This exists to correct cards written before runner.ts became
 * model-aware (every card was priced at Opus rates, overstating Haiku ~10-15x).
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { priceFor } from "./runner";
import type { Card } from "./types";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const round = (n: number, d: number): number => Math.round(n * 10 ** d) / 10 ** d;

function main(): void {
  const model = process.argv[2];
  const match = process.argv[3];
  if (!model || !match) {
    process.stderr.write("usage: restamp-cost.ts <model> <filename-substring>\n");
    process.exit(2);
  }
  const { rates } = priceFor(model);
  const dir = join(REPO, "bench", "results", "suite");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f.includes(match));
  for (const f of files) {
    const p = join(dir, f);
    const card = JSON.parse(readFileSync(p, "utf8")) as Card;
    const c = card.cost;
    const before = c.est_usd;
    c.pricing_model = model;
    c.pricing_rates = rates;
    c.est_usd = round(
      (c.llm_input_tokens / 1e6) * rates.llmIn +
        (c.llm_output_tokens / 1e6) * rates.llmOut +
        (c.embedding_tokens / 1e6) * rates.embed,
      4,
    );
    writeFileSync(p, JSON.stringify(card, null, 2));
    process.stderr.write(`${f}: $${before} -> $${c.est_usd} @ ${model}\n`);
  }
  process.stderr.write(`re-stamped ${files.length} card(s)\n`);
}

main();
