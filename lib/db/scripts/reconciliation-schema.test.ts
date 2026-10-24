import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertHistoricalInventorySchema,
  assertInventoryHistoryRepairSchema,
  assertReconciliationSchema,
  type SchemaObject,
} from "./reconciliation-schema.js";

const fixture = (name: string): SchemaObject[] => JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8"));
const before = fixture("historical-inventory-schema-before-0077.json");
const after = before.map(row => row.kind === "function" && row.key === "block_live_inventory_model_change"
  ? { ...row, digest: "9fdf8e5f455713a5c5a67da35b2d0cbe" } : row);
const tail = fixture("reconciliation-schema-0077.json");
const client = (rows: SchemaObject[]) => ({ query: async () => ({ rows }) }) as unknown as Parameters<typeof assertReconciliationSchema>[0];

test("historical schema accepts only its exact pre-0077 and applied-0077 states", () => {
  assert.doesNotThrow(() => assertHistoricalInventorySchema(before, false));
  assert.doesNotThrow(() => assertHistoricalInventorySchema(after, true));
  assert.throws(() => assertHistoricalInventorySchema(before, true));
  assert.throws(() => assertHistoricalInventorySchema(after, false));
});

test("historical schema still rejects every changed, missing, or extra object", () => {
  for (const [objects, applied] of [[before, false], [after, true]] as const) {
    for (let index = 0; index < objects.length; index++) {
      assert.throws(() => assertHistoricalInventorySchema(objects.map((row, i) => i === index ? { ...row, digest: "0".repeat(32) } : row), applied));
      assert.throws(() => assertHistoricalInventorySchema(objects.filter((_, i) => i !== index), applied));
    }
    assert.throws(() => assertHistoricalInventorySchema([...objects, objects[0]], applied));
  }
});

test("0077 table, functions, constraints, indexes and enabled triggers match exact reviewed SQL", async () => {
  await assertReconciliationSchema(client(tail));
  await assertReconciliationSchema(client([...tail].reverse()));
});

test("0077 validator rejects every changed, missing, or additional schema object", async () => {
  await assert.rejects(assertReconciliationSchema(client([])));
  for (let index = 0; index < tail.length; index++) {
    await assert.rejects(assertReconciliationSchema(client(tail.map((row, i) => i === index ? { ...row, digest: "0".repeat(32) } : row))));
    await assert.rejects(assertReconciliationSchema(client(tail.filter((_, i) => i !== index))));
  }
  await assert.rejects(assertReconciliationSchema(client([...tail, tail[0]])));
});

test("0078 repair schema validator fails closed unless every structural check passes", async () => {
  const healthyClient = {
    query: async () => ({ rows: [{ healthy: true }] }),
  } as unknown as Parameters<typeof assertInventoryHistoryRepairSchema>[0];
  const unhealthyClient = {
    query: async () => ({ rows: [{ healthy: false }] }),
  } as unknown as Parameters<typeof assertInventoryHistoryRepairSchema>[0];
  await assertInventoryHistoryRepairSchema(healthyClient);
  await assert.rejects(
    assertInventoryHistoryRepairSchema(unhealthyClient),
    /0078 inventory history repair schema/,
  );
});
