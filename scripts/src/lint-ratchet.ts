import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const THRESHOLD_FILE = resolve(REPO_ROOT, ".lint-threshold");

const LINTED_PACKAGES = [
  "artifacts/api-server",
  "artifacts/platform",
  "artifacts/mockup-sandbox",
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

function readThreshold(): number {
  if (!existsSync(THRESHOLD_FILE)) {
    console.error(`  Threshold file not found: ${THRESHOLD_FILE}`);
    console.error("  Run: pnpm lint:ratchet --update  to set the baseline.");
    process.exit(1);
  }
  const raw = readFileSync(THRESHOLD_FILE, "utf8").trim();
  const n = parseInt(raw, 10);
  if (isNaN(n)) {
    console.error(`  Threshold file contains invalid value: "${raw}"`);
    process.exit(1);
  }
  return n;
}

function writeThreshold(n: number): void {
  writeFileSync(THRESHOLD_FILE, String(n) + "\n", "utf8");
}

const updateMode = process.argv.includes("--update");

console.log("=".repeat(60));
console.log("  LINT WARNING RATCHET");
console.log("=".repeat(60));
console.log();

let totalWarnings = 0;
for (const pkg of LINTED_PACKAGES) {
  const count = countWarningsInPackage(pkg);
  console.log(`  ${pkg}: ${count} warning(s)`);
  totalWarnings += count;
}

console.log();
console.log(`  Total warnings: ${totalWarnings}`);
console.log();

if (updateMode) {
  writeThreshold(totalWarnings);
  console.log(`  Baseline updated → ${totalWarnings} (written to .lint-threshold)`);
  console.log();
  console.log("  Commit .lint-threshold to make this the new ceiling.");
  console.log("=".repeat(60));
  process.exit(0);
}

const threshold = readThreshold();
console.log(`  Threshold:       ${threshold}`);
console.log();

if (totalWarnings > threshold) {
  console.error("  ✗ WARNING COUNT EXCEEDS THRESHOLD — failing.");
  console.error(`    ${totalWarnings} warning(s) found, limit is ${threshold}.`);
  console.error();
  console.error("  Fix warnings before introducing new ones, then update the");
  console.error("  baseline by running:  pnpm lint:ratchet --update");
  console.error("  and committing the updated .lint-threshold file.");
  console.error("=".repeat(60));
  process.exit(1);
} else {
  const headroom = threshold - totalWarnings;
  console.log(`  ✓ Within threshold (${headroom} below the ceiling).`);
  console.log("=".repeat(60));
  process.exit(0);
}
