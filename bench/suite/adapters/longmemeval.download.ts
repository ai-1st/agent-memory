#!/usr/bin/env -S npx tsx
/**
 * Fetch the LongMemEval dataset into bench/data/longmemeval/ (gitignored).
 *
 *   npx tsx bench/suite/adapters/longmemeval.download.ts            # oracle (default, ~15MB)
 *   npx tsx bench/suite/adapters/longmemeval.download.ts s          # the medium "s" variant
 *
 * Source: HuggingFace `xiaowu0162/longmemeval-cleaned` — the dataset maintainer's
 * cleaned release of the ICLR'25 LongMemEval data (removes noisy history sessions
 * that interfere with answer correctness). The oracle variant keeps only the
 * evidence sessions, so it is small and tractable to ingest.
 *
 * Repo/paper: https://github.com/xiaowu0162/LongMemEval  (Wu et al., ICLR 2025)
 * License: see the upstream repo/HF card (research benchmark; not redistributed here).
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const OUT_DIR = join(REPO, "bench", "data", "longmemeval");

const FILES: Record<string, string> = {
  oracle: "longmemeval_oracle.json",
  s: "longmemeval_s_cleaned.json",
};

const BASE = "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main";

async function main(): Promise<void> {
  const which = (process.argv[2] ?? "oracle").toLowerCase();
  const file = FILES[which];
  if (!file) {
    process.stderr.write(`unknown variant "${which}" (use: ${Object.keys(FILES).join(", ")})\n`);
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const url = `${BASE}/${file}`;
  const dest = join(OUT_DIR, file);
  process.stderr.write(`downloading ${url}\n  -> ${dest}\n`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    process.stderr.write(`HTTP ${res.status} ${res.statusText}\n`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFileSync } = await import("node:fs");
  writeFileSync(dest, buf);
  process.stderr.write(`wrote ${buf.length} bytes\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
