import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../drizzle");
const journal = JSON.parse(readFileSync(resolve(root, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
const tag = "0080_csr_delivery_closeout_accounting";
const migration = readFileSync(resolve(root, `${tag}.sql`), "utf8");

test("delivery closeout accounting is in the verified journal after 0079", () => {
  assert.deepEqual(journal.entries.slice(-2).map(({ idx, tag: name }) => [idx, name]), [[53, "0079_verified_zero_opening_counts"], [54, tag]]);
  assert.match(createHash("sha256").update(migration).digest("hex"), /^[a-f0-9]{64}$/);
  assert.equal(existsSync(resolve(import.meta.dirname, "../migrations/202610280001_csr_delivery_closeout_accounting.sql")), false);
});

test("migration keeps quote history honest and scopes accounting references by tenant", () => {
  assert.match(migration, /status = 'expired'[\s\S]*?consumed_at IS NULL AND dropoff_eta IS NULL/);
  assert.doesNotMatch(migration, /SET dropoff_eta = COALESCE/);
  assert.match(migration, /shift_closeout_packages_tenant_id_id_unique UNIQUE \(tenant_id, id\)/);
  assert.match(migration, /commission_snapshots_tenant_package_fk[\s\S]*?FOREIGN KEY \(tenant_id, closeout_package_id\)[\s\S]*?REFERENCES shift_closeout_packages \(tenant_id, id\)/);
  assert.match(migration, /order_items_commission_amounts_check[\s\S]*?commission_discount_amount <= commission_gross_amount/);
  assert.match(migration, /shift_earning_lines_tenant_package_fk FOREIGN KEY \(tenant_id, closeout_package_id\) REFERENCES shift_closeout_packages\(tenant_id, id\)/);
  assert.match(migration, /shift_earning_lines_tenant_order_fk[\s\S]*?FOREIGN KEY \(tenant_id, source_order_id\)[\s\S]*?REFERENCES orders \(tenant_id, id\)/);
  assert.match(migration, /shift_earning_lines_immutable/);
});
