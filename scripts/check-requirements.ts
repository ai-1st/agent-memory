/**
 * Guardrail: assert every FORMAL requirement of the assignment is satisfied.
 * Static checks only (fast) so it runs in pre-commit and CI on every commit.
 * REQUIRED checks fail the build (exit 1); RECOMMENDED checks only warn.
 *
 *   npm run check:reqs
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// Hono route style + param syntax.
const REQUIRED_ENDPOINTS: Array<[string, string]> = [
  ["get", "/health"],
  ["post", "/turns"],
  ["post", "/recall"],
  ["post", "/search"],
  ["get", "/users/:user_id/memories"],
  ["delete", "/sessions/:session_id"],
  ["delete", "/users/:user_id"],
];

const README_SECTIONS = [
  "architecture",
  "backing store",
  "extraction",
  "recall",
  "fact evolution",
  "tradeoff",
  "failure mode",
  "test",
];

interface Check {
  ok: boolean;
  required: boolean;
  name: string;
  detail?: string;
}
const results: Check[] = [];
const check = (
  ok: boolean,
  name: string,
  opts: { required?: boolean; detail?: string } = {},
): void => {
  results.push({ ok, required: opts.required ?? true, name, detail: opts.detail });
};

const read = (rel: string): string => {
  const p = join(REPO, rel);
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
};
const nonEmptyDir = (rel: string): boolean => {
  const p = join(REPO, rel);
  try {
    return statSync(p).isDirectory() && readdirSync(p).length > 0;
  } catch {
    return false;
  }
};
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// -- §6 required files & directories -------------------------------------- //
for (const f of [
  "README.md",
  "CHANGELOG.md",
  "docker-compose.yml",
  "Dockerfile",
  ".env.example",
  "package.json",
  "tsconfig.json",
]) {
  check(existsSync(join(REPO, f)), `file exists: ${f}`);
}
for (const d of ["src", "tests", "fixtures"]) {
  check(nonEmptyDir(d), `non-empty dir: ${d}/`);
}

// -- §3 endpoint contract ------------------------------------------------- //
const srcText = walk(join(REPO, "src"))
  .filter((p) => p.endsWith(".ts"))
  .map((p) => readFileSync(p, "utf-8"))
  .join("\n");
const found = new Set<string>();
const routeRe = /app\.(get|post|delete|put|patch)\(\s*["'`]([^"'`]+)["'`]/g;
for (let m = routeRe.exec(srcText); m !== null; m = routeRe.exec(srcText)) {
  found.add(`${m[1]?.toLowerCase()} ${m[2]}`);
}
for (const [method, path] of REQUIRED_ENDPOINTS) {
  check(found.has(`${method} ${path}`), `endpoint: ${method.toUpperCase()} ${path}`);
}

// -- §5/§8 deployment constraints ----------------------------------------- //
const compose = read("docker-compose.yml");
check(compose.includes("8080"), "docker-compose maps/uses port 8080", {
  detail: "spec default port",
});
check(compose.includes("volumes:"), "docker-compose declares a volume (persistence)");
check(compose.includes("build"), "docker-compose builds the service");
const dockerfile = read("Dockerfile");
check(
  dockerfile.includes("EXPOSE") || dockerfile.includes("8080"),
  "Dockerfile references the port",
  { required: false },
);

// -- §6 README sections --------------------------------------------------- //
const readme = read("README.md").toLowerCase();
for (const s of README_SECTIONS)
  check(readme.includes(s), `README covers: ${s}`, { required: false });

// -- §6 CHANGELOG: 1 required, 4+ recommended ----------------------------- //
const changelog = read("CHANGELOG.md");
const entries = (changelog.match(/^##\s+\S/gm) ?? []).length;
check(entries >= 1, "CHANGELOG has >= 1 entry", { detail: `${entries} found` });
check(entries >= 4, "CHANGELOG has >= 4 entries (spec: shows iteration)", {
  required: false,
  detail: `${entries} found`,
});

// -- §7 test coverage hints ----------------------------------------------- //
const testFiles = nonEmptyDir("tests")
  ? readdirSync(join(REPO, "tests")).join(" ").toLowerCase()
  : "";
for (const kind of ["contract", "persistence", "concurrent", "robust", "recallquality"]) {
  check(testFiles.includes(kind), `test file present: *${kind}*`, { required: false });
}

// -- report --------------------------------------------------------------- //
let hardFail = 0;
let warns = 0;
console.log(`Assignment requirement checklist\n${"=".repeat(40)}`);
for (const r of results) {
  const mark = r.ok ? "✓" : r.required ? "✗" : "⚠";
  console.log(` ${mark} ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  if (!r.ok && r.required) hardFail++;
  else if (!r.ok) warns++;
}
console.log("=".repeat(40));
console.log(
  `${results.length} checks · ${hardFail} required failing · ${warns} recommended warnings`,
);
if (hardFail > 0) {
  console.log("\nFAILED: required formal requirements are not satisfied.");
  process.exit(1);
}
console.log("\nOK: all required formal requirements satisfied.");
