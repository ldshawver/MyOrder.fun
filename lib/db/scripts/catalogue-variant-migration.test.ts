import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../drizzle");
const journal = JSON.parse(readFileSync(resolve(root, "meta/_journal.json"), "utf8"));
const migration = readFileSync(resolve(root, "0075_catalogue_variant_attributes.sql"), "utf8");
const wooMigration = readFileSync(resolve(root, "0076_tenant_woo_store_url_no_default.sql"), "utf8");
const validator = readFileSync(resolve(import.meta.dirname, "validate-migration-ledger.ts"), "utf8");

test("variant support remains migration 0075 and 0076 is appended afterward", () => {
  assert.deepEqual(journal.entries.find((entry: { idx: number }) => entry.idx === 48), { idx: 48, version: "7", when: 1790985600001,
    tag: "0074_tenant_slug_case_insensitive_unique", breakpoints: true });
  assert.deepEqual(journal.entries.find((entry: { idx: number }) => entry.idx === 49), { idx: 49, version: "7", when: 1790985600002,
    tag: "0075_catalogue_variant_attributes", breakpoints: true });
  assert.deepEqual(journal.entries.find((entry: { idx: number }) => entry.idx === 50), { idx: 50, version: "7", when: 1791358517378,
    tag: "0076_tenant_woo_store_url_no_default", breakpoints: true });
  assert.deepEqual(journal.entries.slice(50, 53).map((entry: { idx: number; tag: string }) => [entry.idx, entry.tag]), [
    [50, "0076_tenant_woo_store_url_no_default"],
    [51, "0077_catalogue_inventory_reconciliation"],
    [52, "0078_inventory_history_baseline_repair"],
  ]);
  assert.equal(createHash("sha256").update(wooMigration).digest("hex"), "99b25cd808d54c1f5d6d957701b64561bd948a3cb4c06aab0000b047ede66e73");
  assert.match(migration, /option_values jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(migration, /catalogue_options_product_values_unique\s+UNIQUE \(tenant_id, product_id, option_values\)/);
  assert.match(migration, /variant_snapshot jsonb/);
  assert.match(migration, /Duplicate tenant catalogue SKUs require controlled reconciliation/);
  assert.match(migration, /catalog_items_tenant_sku_ci_unique/);
  assert.match(migration, /catalog_items_tenant_woo_variation_unique/);
  assert.match(validator, /indexname NOT IN \('catalogue_options_product_values_unique','catalog_items_tenant_woo_variation_unique','catalog_items_tenant_sku_ci_unique'\)/);
});
