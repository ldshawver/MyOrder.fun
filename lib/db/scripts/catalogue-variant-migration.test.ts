import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../drizzle");
const journal = JSON.parse(readFileSync(resolve(root, "meta/_journal.json"), "utf8"));
const migration = readFileSync(resolve(root, "0075_catalogue_variant_attributes.sql"), "utf8");
const wooSyncMigration = readFileSync(resolve(root, "0077_woocommerce_sync_jobs_and_stock_snapshots.sql"), "utf8");
const pushAlertsMigration = readFileSync(resolve(root, "0078_order_web_push_alerts.sql"), "utf8");
const notificationProvidersMigration = readFileSync(resolve(root, "0079_order_notification_provider_settings.sql"), "utf8");
const orderPrintOutboxMigration = readFileSync(resolve(root, "0080_order_print_outbox.sql"), "utf8");
const pwaSubscriptionsMigration = readFileSync(resolve(root, "0081_pwa_push_subscriptions.sql"), "utf8");
const defaultLocationMigration = readFileSync(resolve(root, "0082_default_inventory_location.sql"), "utf8");
const validator = readFileSync(resolve(import.meta.dirname, "validate-migration-ledger.ts"), "utf8");

test("variant support remains migration 0075 and later Woo migrations stay append-only", () => {
  assert.deepEqual(journal.entries.find((entry: { idx: number }) => entry.idx === 48), { idx: 48, version: "7", when: 1790985600001,
    tag: "0074_tenant_slug_case_insensitive_unique", breakpoints: true });
  assert.deepEqual(journal.entries.find((entry: { idx: number }) => entry.idx === 49), { idx: 49, version: "7", when: 1790985600002,
    tag: "0075_catalogue_variant_attributes", breakpoints: true });
  assert.equal(journal.entries.find((entry: { idx: number }) => entry.idx === 50).tag, "0076_tenant_woo_store_url_no_default");
  assert.equal(journal.entries.find((entry: { idx: number }) => entry.idx === 51).tag, "0077_woocommerce_sync_jobs_and_stock_snapshots");
  assert.equal(journal.entries.find((entry: { idx: number }) => entry.idx === 55).tag, "0081_pwa_push_subscriptions");
  assert.equal(journal.entries.find((entry: { idx: number }) => entry.idx === 56).tag, "0082_default_inventory_location");
  assert.match(migration, /option_values jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(migration, /catalogue_options_product_values_unique\s+UNIQUE \(tenant_id, product_id, option_values\)/);
  assert.match(migration, /variant_snapshot jsonb/);
  assert.match(migration, /Duplicate tenant catalogue SKUs require controlled reconciliation/);
  assert.match(migration, /catalog_items_tenant_sku_ci_unique/);
  assert.match(migration, /catalog_items_tenant_woo_variation_unique/);
  assert.match(validator, /indexname NOT IN \('catalogue_options_product_values_unique','catalog_items_tenant_woo_variation_unique','catalog_items_tenant_sku_ci_unique'\)/);
  assert.match(defaultLocationMigration, /ADD COLUMN IF NOT EXISTS default_inventory_location_id integer/);
  assert.match(defaultLocationMigration, /FOREIGN KEY \(tenant_id, default_inventory_location_id\)/);
  assert.match(wooSyncMigration, /woocommerce_sync_jobs_one_active_tenant_idx/);
  assert.match(wooSyncMigration, /woocommerce_stock_snapshots_parent_unique/);
  assert.match(wooSyncMigration, /woocommerce_stock_location_assignments/);
  assert.match(wooSyncMigration, /FOREIGN KEY \(tenant_id, location_id\)/);
  assert.match(pushAlertsMigration, /web_push_order_alerts_enabled boolean NOT NULL DEFAULT false/);
  assert.match(pushAlertsMigration, /UNIQUE \(tenant_id,event_id,recipient_user_id\)/);
  assert.match(orderPrintOutboxMigration, /CREATE TABLE IF NOT EXISTS order_print_outbox/);
  assert.match(orderPrintOutboxMigration, /UNIQUE \(tenant_id, order_id\)/);
  assert.match(pwaSubscriptionsMigration, /CREATE TABLE IF NOT EXISTS pwa_push_subscriptions/);
  assert.match(pwaSubscriptionsMigration, /CREATE INDEX IF NOT EXISTS pwa_push_subscriptions_user_active_idx/);
  assert.match(pwaSubscriptionsMigration, /CREATE INDEX IF NOT EXISTS pwa_push_subscriptions_tenant_active_idx/);
});

test("notification provider credentials and cash tax preference use tenant-scoped encrypted storage", () => {
  assert.match(notificationProvidersMigration, /sms_credentials_ciphertext/);
  assert.match(notificationProvidersMigration, /tuya_credentials_ciphertext/);
  assert.match(notificationProvidersMigration, /cash_tax_inclusive boolean NOT NULL DEFAULT false/);
  assert.match(notificationProvidersMigration, /ALTER TABLE order_notification_settings/);
});
