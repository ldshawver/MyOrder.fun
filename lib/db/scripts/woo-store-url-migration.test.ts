import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { validateAppliedLineage, type LineageAppliedMigration, type LineageMigration } from "./migration-lineage.js";

const root = resolve(import.meta.dirname, "../drizzle");
const journal = JSON.parse(readFileSync(resolve(root, "meta/_journal.json"), "utf8"));
const migration = readFileSync(resolve(root, "0076_tenant_woo_store_url_no_default.sql"), "utf8");
const local = journal.entries.map((entry: Omit<LineageMigration, "hash">) => ({
  ...entry,
  hash: createHash("sha256").update(readFileSync(resolve(root, `${entry.tag}.sql`))).digest("hex"),
})) as LineageMigration[];
const applied = local.map<LineageAppliedMigration>((entry, index) => ({
  id: index + 1,
  hash: entry.hash,
  created_at: String(entry.when),
}));

test("Woo URL has no merchant-specific default and migration 0076 is append-only", () => {
  assert.deepEqual(journal.entries.find((entry: { idx: number }) => entry.idx === 50), {
    idx: 50,
    version: "7",
    when: 1791358517378,
    tag: "0076_tenant_woo_store_url_no_default",
    breakpoints: true,
  });
  assert.equal(local[50].hash, "99b25cd808d54c1f5d6d957701b64561bd948a3cb4c06aab0000b047ede66e73");
  assert.deepEqual(local.slice(50, 53).map(({ idx, tag }) => [idx, tag]), [
    [50, "0076_tenant_woo_store_url_no_default"],
    [51, "0077_catalogue_inventory_reconciliation"],
    [52, "0078_inventory_history_baseline_repair"],
  ]);
  assert.match(migration, /ALTER COLUMN wc_store_url DROP DEFAULT/);
  assert.doesNotMatch(migration, /\b(UPDATE|DELETE|INSERT)\b/i);
  const settings = readFileSync(resolve(root, "../src/schema/settings.ts"), "utf8");
  assert.match(settings, /wcStoreUrl: text\("wc_store_url"\),/);
  assert.doesNotMatch(settings, /https:\/\/(?:store\.)?lucifercruz\.com/);
});

test("0076 through 0078 history rejects invalid, missing, or reordered rows", () => {
  assert.equal(validateAppliedLineage(local, applied).appliedJournalIndices.size, local.length);

  const invalid = applied.map((row) => ({ ...row }));
  invalid[50].hash = "0".repeat(64);
  assert.throws(() => validateAppliedLineage(local, invalid));

  const missing = applied.filter((_, index) => index !== 50);
  assert.throws(() => validateAppliedLineage(local, missing));

  const reordered = applied.map((row) => ({ ...row }));
  [reordered[50], reordered[51]] = [reordered[51], reordered[50]];
  assert.throws(() => validateAppliedLineage(local, reordered));
});
