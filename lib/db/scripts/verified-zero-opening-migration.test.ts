import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../drizzle");
const journal = JSON.parse(readFileSync(resolve(root, "meta/_journal.json"), "utf8"));
const migration = readFileSync(resolve(root, "0079_verified_zero_opening_counts.sql"), "utf8");

test("0079 is followed by the canonical 0080 accounting migration", () => {
  assert.deepEqual(journal.entries.slice(52, 55).map((entry: { idx: number; tag: string }) => [entry.idx, entry.tag]), [
    [52, "0078_inventory_history_baseline_repair"],
    [53, "0079_verified_zero_opening_counts"],
    [54, "0080_csr_delivery_closeout_accounting"],
  ]);
});

test("0079 retains nonzero movements and permits only a fully identified zero opening count", () => {
  assert.match(migration, /"quantity_delta" <> 0/);
  for (const invariant of [
    /"movement_type" = 'correction'/,
    /"source_type" = 'verified_opening_count'/,
    /"reason_code" = 'opening_count'/,
    /"pre_quantity" = 0/,
    /"post_quantity" = 0/,
    /"destination_location_id" IS NULL/,
    /"unit_cost" IS NULL/,
    /"extended_cost" = 0/,
  ]) assert.match(migration, invariant);
});
