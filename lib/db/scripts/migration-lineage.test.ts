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

test("49-row staging permits only 0077 and recognizes its exact 50-row continuation", () => {
  const before = [...staging];
  for (const index of [39, 40, 41, 42, 46, 47, 48, 49, 50]) {
    before.push({ id: before.length + 1, hash: local[index].hash, created_at: String(local[index].when) });
  }
  assert.equal(before.length, 49);
  const verified = validateAppliedLineage(local, before);
  const pending = local.map((_: unknown, index: number) => index)
    .filter((index: number) => !verified.appliedJournalIndices.has(index));
  assert.deepEqual(pending, [51]);
  assert.equal(local[51].tag, "0077_catalogue_inventory_reconciliation");
  assert.deepEqual(historicalStagingInventory.forwardIndices.slice(before.length - 40), pending);

  const next = { id: 50, hash: local[51].hash, created_at: String(local[51].when) };
  const after = [...before, next];
  assert.equal(after.length, 50);
  assert.equal(validateAppliedLineage(local, after).appliedJournalIndices.size, local.length);
  assert.deepEqual(historicalStagingInventory.forwardIndices.slice(after.length - 40), []);

  assert.throws(() => validateAppliedLineage(local, [...before, { ...next, hash: "0".repeat(64) }]));
  assert.throws(() => validateAppliedLineage(local, [...before, { ...next, created_at: String(local[51].when + 1) }]));
  assert.throws(() => validateAppliedLineage(local, [...before.slice(0, -1), next]));
  assert.throws(() => validateAppliedLineage(local, [...after, { ...next, id: 51 }]));
});
