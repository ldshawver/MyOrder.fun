import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  historicalStaging0047,
  historicalStaging0058,
  historicalStagingInventory,
  validateAppliedLineage,
} from "./migration-lineage.js";

const root = resolve(import.meta.dirname, "..", "drizzle");
const local = JSON.parse(readFileSync(resolve(root, "meta/_journal.json"), "utf8")).entries
  .map((entry: { idx: number; tag: string; when: number }) => ({
    ...entry,
    hash: createHash("sha256").update(readFileSync(resolve(root, `${entry.tag}.sql`))).digest("hex"),
  }));
const staging = [
  ...local.slice(0, 24).map((entry: { hash: string; when: number }) => ({ hash: entry.hash, created_at: String(entry.when) })),
  { hash: historicalStaging0047.historicalHash, created_at: String(historicalStaging0047.historicalWhen) },
  ...local.slice(27, 39).map((entry: { hash: string; when: number }) => ({ hash: entry.hash, created_at: String(entry.when) })),
  ...historicalStagingInventory.rows.map((entry) => ({ hash: entry.hash, created_at: String(entry.when) })),
].map((entry, index) => ({ id: index + 1, ...entry }));
staging[33] = { ...staging[33], hash: historicalStaging0058.hash };

test("production 0067 boundary leaves 0068 and later journal history pending", () => {
  const boundaryIndex = local.findIndex((entry: { tag: string }) => entry.tag === "0067_print_routes_document_types");
  const deferredIndex = local.findIndex((entry: { tag: string }) => entry.tag === "0068_print_jobs_document_job_types");
  assert.equal(boundaryIndex, 41);
  assert.equal(deferredIndex, boundaryIndex + 1);
  assert.equal(local.slice(0, deferredIndex).length, 42);
  assert.equal(local[deferredIndex].tag, "0068_print_jobs_document_job_types");
  assert.ok(local.length > deferredIndex + 1, "later migration journal entries remain present");
});

test("exact historical staging lineage and ordered forward continuation", () => {
  const verified = validateAppliedLineage(local, staging);
  assert.equal(verified.historicalStagingInventoryRecognized, true);
  assert.deepEqual([39, 40, 41, 42, 46, 47, 48, 49, 50].filter((index) => !verified.appliedJournalIndices.has(index)), [39, 40, 41, 42, 46, 47, 48, 49, 50]);
  const continued = [...staging];
  for (const index of historicalStagingInventory.forwardIndices) {
    continued.push({ id: continued.length + 1, hash: local[index].hash, created_at: String(local[index].when) });
    assert.equal(validateAppliedLineage(local, continued).historicalStagingInventoryRecognized, true);
  }
  assert.equal(validateAppliedLineage(local, continued).appliedJournalIndices.size, local.length);
});

test("unknown, missing, reordered and fabricated historical rows fail", () => {
  const changed = staging.map((row) => ({ ...row }));
  changed[37].hash = "0".repeat(64);
  assert.throws(() => validateAppliedLineage(local, changed));
  const missing = staging.filter((_, index) => index !== 38);
  assert.throws(() => validateAppliedLineage(local, missing));
  const reordered = staging.map((row) => ({ ...row }));
  [reordered[37], reordered[38]] = [reordered[38], reordered[37]];
  assert.throws(() => validateAppliedLineage(local, reordered));
  assert.throws(() => validateAppliedLineage(local, [...staging, { id: 41, hash: "0".repeat(64), created_at: "0" }]));
  const changedCanonical = local.map((entry: { hash: string }) => ({ ...entry }));
  changedCanonical[43].hash = "0".repeat(64);
  assert.throws(() => validateAppliedLineage(changedCanonical, staging));
  const fabricatedId = staging.map((row) => ({ ...row }));
  fabricatedId[37].id = 999;
  assert.throws(() => validateAppliedLineage(local, fabricatedId));
});

test("49-row staging permits only the ordered 0077 through 0082 continuation", () => {
  const before = [...staging];
  for (const index of [39, 40, 41, 42, 46, 47, 48, 49, 50]) {
    before.push({ id: before.length + 1, hash: local[index].hash, created_at: String(local[index].when) });
  }
  assert.equal(before.length, 49);
  const verified = validateAppliedLineage(local, before);
  const pending = local.map((_: unknown, index: number) => index)
    .filter((index: number) => !verified.appliedJournalIndices.has(index));
  assert.deepEqual(pending, [51, 52, 53, 54, 55, 56]);
  assert.equal(local[51].tag, "0077_catalogue_inventory_reconciliation");
  assert.equal(local[52].tag, "0078_inventory_history_baseline_repair");
  assert.equal(local[53].tag, "0079_verified_zero_opening_counts");
  assert.equal(local[54].tag, "0080_csr_delivery_closeout_accounting");
  assert.equal(local[55].tag, "0081_csr_inventory_accountability");
  assert.equal(local[56].tag, "0082_location_pickup_scheduling");
  assert.deepEqual(historicalStagingInventory.forwardIndices.slice(before.length - 40), pending);

  const reconciliation = { id: 50, hash: local[51].hash, created_at: String(local[51].when) };
  const afterReconciliation = [...before, reconciliation];
  assert.equal(afterReconciliation.length, 50);
  const reconciliationVerified = validateAppliedLineage(local, afterReconciliation);
  assert.deepEqual(
    local.map((_: unknown, index: number) => index)
      .filter((index: number) => !reconciliationVerified.appliedJournalIndices.has(index)),
    [52, 53, 54, 55, 56],
  );
  assert.deepEqual(historicalStagingInventory.forwardIndices.slice(afterReconciliation.length - 40), [52, 53, 54, 55, 56]);

  const repair = { id: 51, hash: local[52].hash, created_at: String(local[52].when) };
  const afterRepair = [...afterReconciliation, repair];
  assert.equal(afterRepair.length, 51);
  assert.deepEqual(
    local.map((_: unknown, index: number) => index)
      .filter((index: number) => !validateAppliedLineage(local, afterRepair).appliedJournalIndices.has(index)),
    [53, 54, 55, 56],
  );
  assert.deepEqual(historicalStagingInventory.forwardIndices.slice(afterRepair.length - 40), [53, 54, 55, 56]);

  const zeroOpening = { id: 52, hash: local[53].hash, created_at: String(local[53].when) };
  const afterZeroOpening = [...afterRepair, zeroOpening];
  assert.deepEqual(local.map((_: unknown, index: number) => index).filter((index: number) => !validateAppliedLineage(local, afterZeroOpening).appliedJournalIndices.has(index)), [54, 55, 56]);
  assert.deepEqual(historicalStagingInventory.forwardIndices.slice(afterZeroOpening.length - 40), [54, 55, 56]);

  const accounting = { id: 53, hash: local[54].hash, created_at: String(local[54].when) };
  const afterAccounting = [...afterZeroOpening, accounting];
  assert.deepEqual(local.map((_: unknown, index: number) => index).filter((index: number) => !validateAppliedLineage(local, afterAccounting).appliedJournalIndices.has(index)), [55, 56]);
  assert.deepEqual(historicalStagingInventory.forwardIndices.slice(afterAccounting.length - 40), [55, 56]);

  const accountability = { id: 54, hash: local[55].hash, created_at: String(local[55].when) };
  const afterAccountability = [...afterAccounting, accountability];
  assert.deepEqual(local.map((_: unknown, index: number) => index).filter((index: number) => !validateAppliedLineage(local, afterAccountability).appliedJournalIndices.has(index)), [56]);
  assert.deepEqual(historicalStagingInventory.forwardIndices.slice(afterAccountability.length - 40), [56]);

  const pickupScheduling = { id: 55, hash: local[56].hash, created_at: String(local[56].when) };
  const afterPickupScheduling = [...afterAccountability, pickupScheduling];
  assert.equal(validateAppliedLineage(local, afterPickupScheduling).appliedJournalIndices.size, local.length);
  assert.deepEqual(historicalStagingInventory.forwardIndices.slice(afterPickupScheduling.length - 40), []);

  assert.throws(() => validateAppliedLineage(local, [...before, { ...reconciliation, hash: "0".repeat(64) }]));
  assert.throws(() => validateAppliedLineage(local, [...before, { ...reconciliation, created_at: String(local[51].when + 1) }]));
  assert.throws(() => validateAppliedLineage(local, [...before.slice(0, -1), reconciliation]));
  assert.throws(() => validateAppliedLineage(local, [...afterReconciliation, { ...repair, hash: "0".repeat(64) }]));
  assert.throws(() => validateAppliedLineage(local, [...afterReconciliation, { ...repair, created_at: String(local[52].when + 1) }]));
  assert.throws(() => validateAppliedLineage(local, [...afterReconciliation.slice(0, -1), repair]));
  assert.throws(() => validateAppliedLineage(local, [...afterRepair, { ...repair, id: 52 }]));
  assert.throws(() => validateAppliedLineage(local, [...afterRepair, { ...zeroOpening, hash: "0".repeat(64) }]));
  assert.throws(() => validateAppliedLineage(local, [...afterRepair, { ...zeroOpening, created_at: String(local[53].when + 1) }]));
  assert.throws(() => validateAppliedLineage(local, [...afterRepair.slice(0, -1), zeroOpening]));
  assert.throws(() => validateAppliedLineage(local, [...afterZeroOpening, { ...zeroOpening, id: 53 }]));
  assert.throws(() => validateAppliedLineage(local, [...afterZeroOpening, { ...accounting, hash: "0".repeat(64) }]));
  assert.throws(() => validateAppliedLineage(local, [...afterZeroOpening, { ...accounting, created_at: String(local[54].when + 1) }]));
  assert.throws(() => validateAppliedLineage(local, [...afterAccountability, { ...pickupScheduling, hash: "0".repeat(64) }]));
  assert.throws(() => validateAppliedLineage(local, [...afterAccountability, { ...pickupScheduling, created_at: String(local[56].when + 1) }]));
});
