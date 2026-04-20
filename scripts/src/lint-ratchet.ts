import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const THRESHOLD_FILE = resolve(REPO_ROOT, ".lint-threshold");

const LINTED_PACKAGES: { key: string; relPath: string }[] = [
  { key: "api-server", relPath: "artifacts/api-server" },
  { key: "platform", relPath: "artifacts/platform" },
  { key: "mockup-sandbox", relPath: "artifacts/mockup-sandbox" },
];

interface EslintMessage {
  severity: 1 | 2;
  message: string;
  ruleId: string | null;
  line: number;
  column: number;
}

interface EslintResult {
  filePath: string;
  messages: EslintMessage[];
  warningCount: number;
  errorCount: number;
}

type ThresholdMap = Record<string, number>;

function countWarningsInPackage(pkgRelPath: string): number {
  const pkgDir = resolve(REPO_ROOT, pkgRelPath);
  let json: string;
  try {
    json = execSync("pnpm exec eslint src --format json", {
      cwd: pkgDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (err: unknown) {
    const anyErr = err as { stdout?: string; stderr?: string; status?: number };
    if (anyErr.stdout) {
      json = anyErr.stdout;
    } else {
      console.error(`  Error running eslint in ${pkgRelPath}:`, anyErr.stderr ?? String(err));
      process.exit(1);
    }
  }

  let results: EslintResult[];
  try {
    results = JSON.parse(json) as EslintResult[];
  } catch {
    console.error(`  Failed to parse ESLint JSON output from ${pkgRelPath}`);
    process.exit(1);
  }

  return results.reduce((sum, file) => sum + file.warningCount, 0);
}

function readThreshold(): ThresholdMap {
  if (!existsSync(THRESHOLD_FILE)) {
    console.error(`  Threshold file not found: ${THRESHOLD_FILE}`);
    console.error("  Run: pnpm lint:ratchet --update  to set the baseline.");
    process.exit(1);
  }
  const raw = readFileSync(THRESHOLD_FILE, "utf8").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`  Threshold file contains invalid JSON: "${raw}"`);
    console.error("  Run: pnpm lint:ratchet --update  to regenerate it.");
    process.exit(1);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error(`  Threshold file must contain a JSON object mapping package names to counts.`);
    console.error("  Run: pnpm lint:ratchet --update  to regenerate it.");
    process.exit(1);
  }

  const map = parsed as Record<string, unknown>;
  const result: ThresholdMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      console.error(`  Threshold file has invalid count for "${k}": ${String(v)}`);
      process.exit(1);
    }
    result[k] = v;
  }
  return result;
}

function writeThreshold(counts: ThresholdMap): void {
  writeFileSync(THRESHOLD_FILE, JSON.stringify(counts, null, 2) + "\n", "utf8");
}

const updateMode = process.argv.includes("--update");

console.log("=".repeat(60));
console.log("  LINT WARNING RATCHET");
console.log("=".repeat(60));
console.log();

const currentCounts: ThresholdMap = {};
let totalWarnings = 0;
for (const { key, relPath } of LINTED_PACKAGES) {
  const count = countWarningsInPackage(relPath);
  currentCounts[key] = count;
  totalWarnings += count;
  console.log(`  ${key}: ${count} warning(s)`);
}

console.log();
console.log(`  Total warnings: ${totalWarnings}`);
console.log();

if (updateMode) {
  writeThreshold(currentCounts);
  console.log("  Baseline updated per package:");
  for (const [key, count] of Object.entries(currentCounts)) {
    console.log(`    ${key}: ${count}`);
  }
  console.log();
  console.log("  Commit .lint-threshold to make these the new ceilings.");
  console.log("=".repeat(60));
  process.exit(0);
}

const thresholds = readThreshold();

let anyFailed = false;
const failedPackages: string[] = [];

for (const { key } of LINTED_PACKAGES) {
  const count = currentCounts[key] ?? 0;
  const limit = thresholds[key] ?? 0;
  if (count > limit) {
    anyFailed = true;
    failedPackages.push(key);
    console.error(`  ✗ ${key}: ${count} warning(s) — exceeds limit of ${limit} (regression: +${count - limit})`);
  } else {
    const headroom = limit - count;
    console.log(`  ✓ ${key}: ${count}/${limit} (${headroom} below the ceiling)`);
  }
}

console.log();

if (anyFailed) {
  console.error(
    `  REGRESSION in: ${failedPackages.join(", ")} — failing.`
  );
  console.error();
  console.error("  Fix warnings in the listed package(s) before merging.");
  console.error("  Once fixed, update the baseline with:");
  console.error("    pnpm lint:ratchet --update");
  console.error("  and commit the updated .lint-threshold file.");
  console.error("=".repeat(60));
  process.exit(1);
} else {
  console.log("  ✓ All packages within threshold.");
  console.log("=".repeat(60));
  process.exit(0);
}
