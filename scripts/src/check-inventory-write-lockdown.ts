import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const guardedTables = ["inventory_" + "balances", "inventory_" + "reservations"];
const forbiddenFragments = guardedTables.flatMap(table => ["UPDATE ", "INSERT INTO ", "DELETE FROM "].map(prefix => `${prefix}${table}`));
const allowedAuthorityFile = "artifacts/api-server/src/lib/inventoryAuthority.ts";
const allowedReservationFile = "artifacts/api-server/src/lib/inventoryReservations.ts";
const allowedTestSegments = [`${sep}__tests__${sep}`, `${sep}e2e${sep}`];
const allowedFileSuffixes = [".test.ts", ".spec.ts", ".md"];
const scannedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".sql", ".json"]);
const ignoredDirectories = new Set([".git", "node_modules", ".pnpm-store", "dist", "build", "coverage", ".next", "playwright-report", "test-results"]);

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot) : "";
}

function shouldSkipFile(absPath: string, relPath: string): boolean {
  if (!scannedExtensions.has(extensionOf(absPath))) return true;
  if (relPath === allowedAuthorityFile || relPath === allowedReservationFile) return true;
  if (allowedFileSuffixes.some(suffix => relPath.endsWith(suffix))) return true;
  return allowedTestSegments.some(segment => absPath.includes(segment));
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirectories.has(entry)) continue;
    const abs = resolve(dir, entry);
    const stats = statSync(abs);
    if (stats.isDirectory()) walk(abs, files);
    else files.push(abs);
  }
  return files;
}

const violations: Array<{ file: string; line: number; fragment: string }> = [];
for (const abs of walk(repoRoot)) {
  const rel = relative(repoRoot, abs).split(sep).join("/");
  if (shouldSkipFile(abs, rel)) continue;
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const fragment of forbiddenFragments) {
      if (line.includes(fragment)) violations.push({ file: rel, line: index + 1, fragment });
    }
  });
}

if (violations.length > 0) {
  console.error("DIRECT INVENTORY WRITE BLOCKED — USE inventoryAuthority");
  console.error("Raw SQL writes to guarded inventory tables are forbidden outside the inventory authority/reservation kernel modules.");
  for (const violation of violations) console.error(`${violation.file}:${violation.line} contains ${violation.fragment}`);
  process.exit(1);
}

console.log(`Inventory write lockdown passed: no raw SQL writes to ${guardedTables.join(", ")} outside kernel-approved modules.`);
