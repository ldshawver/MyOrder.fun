import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../drizzle");
const journal = JSON.parse(readFileSync(resolve(root, "meta/_journal.json"), "utf8"));
const migration = readFileSync(resolve(root, "0075_catalogue_variant_attributes.sql"), "utf8");

test("variant support is appended as migration 0075 without rewriting migration 0074", () => {
  assert.deepEqual(journal.entries.at(-2), { idx: 48, version: "7", when: 1790985600001,
    tag: "0074_tenant_slug_case_insensitive_unique", breakpoints: true });
  assert.deepEqual(journal.entries.at(-1), { idx: 49, version: "7", when: 1790985600002,
    tag: "0075_catalogue_variant_attributes", breakpoints: true });
  assert.match(migration, /option_values jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(migration, /catalogue_options_product_values_unique\s+UNIQUE \(tenant_id, product_id, option_values\)/);
  assert.match(migration, /variant_snapshot jsonb/);
  assert.match(migration, /Duplicate tenant catalogue SKUs require controlled reconciliation/);
  assert.match(migration, /catalog_items_tenant_sku_ci_unique/);
  assert.match(migration, /catalog_items_tenant_woo_variation_unique/);
});
