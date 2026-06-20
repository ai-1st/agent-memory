#!/usr/bin/env -S npx tsx
/**
 * Run one benchmark adapter against one running service and emit the three-axis card.
 *
 *   npx tsx bench/suite/run.ts --adapter custom --url http://localhost:8080 --label baseline --limit 50
 *
 * Adapters are resolved by convention from ./adapters/<name>.ts (default export
 * implements the Adapter interface). Datasets live in bench/data/<name>/.
 * Results are written to bench/results/suite/<name>__<label>.json (git-ignored).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { printCard, runScenarios } from "./runner";
import type { Adapter, Scenario } from "./types";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const name = arg("adapter");
  const url = (arg("url", "http://localhost:8080") as string).replace(/\/$/, "");
  const label = arg("label", "run") as string;
  const limitStr = arg("limit");
  const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
  if (!name) {
    process.stderr.write("error: --adapter <name> is required\n");
    process.exit(2);
  }

  const dataDir = join(REPO, "bench", "data", name);
  const mod = await import(new URL(`./adapters/${name}.ts`, import.meta.url).href);
  const adapter: Adapter = mod.default ?? mod.adapter;
  if (!adapter?.load) {
    process.stderr.write(`error: adapter ${name} has no default export implementing Adapter\n`);
    process.exit(2);
  }

  const scenarios: Scenario[] = await adapter.load({ limit, dataDir });
  process.stderr.write(
    `loaded ${scenarios.length} scenarios / ${scenarios.reduce((n, s) => n + s.probes.length, 0)} probes from ${name}\n`,
  );

  const card = await runScenarios(url, scenarios, name, label);
  printCard(card);

  const outDir = join(REPO, "bench", "results", "suite");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${name}__${label}.json`);
  writeFileSync(out, JSON.stringify(card, null, 2));
  process.stderr.write(`\nwrote ${out}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
