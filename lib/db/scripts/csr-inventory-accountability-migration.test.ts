import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../drizzle");
const journal = JSON.parse(readFileSync(resolve(root, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
const tag = "0081_csr_inventory_accountability";
const migration = readFileSync(resolve(root, `${tag}.sql`), "utf8");

test("inventory accountability is the journaled successor to closeout accounting", () => {
  assert.deepEqual(journal.entries.slice(-2).map(({ idx, tag: name }) => [idx, name]), [
    [54, "0080_csr_delivery_closeout_accounting"], [55, tag],
  ]);
});

test("migration keeps shortage values immutable and every operational reference tenant-scoped", () => {
  assert.match(migration, /retail_price_snapshot numeric\(12,2\) NOT NULL/);
  assert.match(migration, /discount_rate = 0\.2/);
  assert.match(migration, /missing_quantity > 0/);
  assert.match(migration, /contractor_inventory_adjustments_policy_check[\s\S]*?carry_forward_to_future_shift_payout/);
  assert.match(migration, /shift_inventory_shortage_lines_tenant_movement_fk FOREIGN KEY \(tenant_id, inventory_movement_id\)/);
  assert.match(migration, /shift_inventory_shortage_lines_shift_item_fk FOREIGN KEY \(shift_id, shift_inventory_item_id\)/);
  assert.match(migration, /contractor_inventory_apps_tenant_source_unique UNIQUE \(tenant_id, source_key\)/);
  assert.match(migration, /contractor_inventory_adjustments_immutable/);
  assert.match(migration, /contractor_inventory_adjustment_applications_immutable/);
  assert.match(migration, /shift_inventory_shortage_lines_immutable/);
});
