import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../wooSafeHttp", () => ({ fetchWooSafely: vi.fn() }));

import { and, eq, sql } from "drizzle-orm";
import {
  adminSettingsTable, catalogItemsTable, db, inventoryBalancesTable, inventoryLocationsTable,
  inventoryReservationsTable, orderItemsTable, ordersTable, pool, tenantSettingsTable, tenantsTable, usersTable,
} from "@workspace/db";
import { encrypt, _resetKeyCacheForTests } from "../crypto";
import { fetchWooSafely } from "../wooSafeHttp";
import { postInventoryMovementInTransaction } from "../inventoryMovementLedger";
import { enqueueWooSync, getTenantWooSyncJob, runWooSyncWorkerOnce } from "../wooSyncJobs";
import { runWooCatalogSync } from "../../routes/woocommerce";

const enabled = process.env.WOO_SYNC_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;
const mockedFetch = vi.mocked(fetchWooSafely);
let tenantId = 0;
let userId = 0;
let locationId = 0;
let variationSalePrice = "9.00";
let includeSecond3867Variation = true;
let disableSecond3867Variation = false;

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fixtureProducts(page: number): Array<Record<string, unknown>> {
  const all = Array.from({ length: 245 }, (_, index) => {
    const id = index === 0 ? 3867 : index === 1 ? 4107 : index === 20 ? 3421 : 80000 + index;
    return {
      id, name: id === 3867 ? "Bottle Product 3867" : id === 4107 ? "Simple Product 4107" : id === 3421 ? "Multi Attribute Product" : `Fixture Product ${id}`,
      type: id === 3867 || id === 3421 ? "variable" : "simple", status: "publish", price: "5.00", regular_price: "5.00", sale_price: "",
      categories: [{ name: "Apparel & Accessories" }], catalog_visibility: "visible", stock_status: "instock", manage_stock: id === 3421 || id === 4107,
      stock_quantity: id === 3421 ? 5 : id === 4107 ? 4 : null, sku: `SKU-${id}`, images: [], description: "fixture", short_description: "fixture",
    };
  });
  return all.slice((page - 1) * 20, page * 20);
}

function wooResponseForPath(path: string): Response {
  if (path.includes("system_status")) return response({ environment: { currency_code: "USD", version: "test" } });
  const productPage = path.match(/\/products\?per_page=20&page=(\d+)/);
  if (productPage) return response(fixtureProducts(Number(productPage[1])), 200, { "x-wp-totalpages": "13", "x-wp-total": "245" });
  if (path === "/wp-json/wc/v3/products/3867") return response({ id: 3867, name: "Bottle Product 3867", type: "variable", status: "publish",
    price: "9.00", regular_price: "10.99", sale_price: "9.00", categories: [{ name: "Apparel & Accessories" }],
    catalog_visibility: "visible", stock_status: "instock", manage_stock: false, sku: "SKU-3867", images: [], description: "fixture", short_description: "fixture" });
  if (path.includes("/products/3867/variations")) return response([
    { id: 3875, status: "publish", sku: "", price: variationSalePrice, regular_price: "10.99", sale_price: variationSalePrice, stock_status: "instock", manage_stock: true, stock_quantity: 10, attributes: [{ name: "Bottle Size", option: "4oz" }] },
    { id: 3874, status: disableSecond3867Variation ? "draft" : "publish", sku: "BOTTLE-2OZ", price: "17.00", regular_price: "18.99", sale_price: "17.00", stock_status: "instock", manage_stock: true, stock_quantity: 10, attributes: [{ name: "Bottle Size", option: "2oz" }] },
  ].filter(variation => includeSecond3867Variation || variation.id !== 3874), 200, { "x-wp-totalpages": "1" });
  if (path.includes("/products/3421/variations")) return response([
    { id: 3423, status: "publish", sku: "MULTI-BLACK-USB", price: "38.26", regular_price: "38.26", stock_status: "instock", manage_stock: false, stock_quantity: null,
      attributes: [{ name: "Color", option: "Black" }, { name: "Electrical outlet", option: "USB" }] },
    { id: 3424, status: "publish", sku: "MULTI-RED-USB", price: "39.26", regular_price: "39.26", stock_status: "outofstock", manage_stock: false, stock_quantity: null,
      attributes: [{ name: "Color", option: "Red" }, { name: "Electrical outlet", option: "USB" }] },
  ], 200, { "x-wp-totalpages": "1" });
  return response([], 200);
}

suite("Woo sync durable worker and importer (isolated PostgreSQL)", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    expect(url.hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
    expect(url.pathname).toMatch(/^\/myorder_woo_repair_migrations$/);
    if (url.port !== "55432" || process.env.TEST_DISPOSABLE_CLONE !== "I_UNDERSTAND_THIS_CLONE_IS_TRUNCATED") {
      throw new Error("Explicit isolated PostgreSQL 16 validation clone required");
    }
    const identity = await pool.query<{ name: string }>("SELECT current_database() AS name");
    if (identity.rows[0]?.name !== "myorder_woo_repair_migrations") {
      throw new Error("Unexpected Woo validation database identity");
    }
    process.env.SETTINGS_ENC_KEY = "woo-isolated-integration-test-key";
    _resetKeyCacheForTests();
    await pool.query(`CREATE TABLE IF NOT EXISTS catalogue_products (
        id serial PRIMARY KEY,tenant_id integer NOT NULL REFERENCES tenants(id),name text NOT NULL,
        inventory_model text NOT NULL DEFAULT 'SEPARATE_VARIANTS',location_evaluation text NOT NULL DEFAULT 'PER_LOCATION',
        active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id));
      CREATE TABLE IF NOT EXISTS inventory_items (
        id serial PRIMARY KEY,tenant_id integer NOT NULL REFERENCES tenants(id),catalog_item_id integer NOT NULL,base_unit text NOT NULL DEFAULT 'each',
        created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,catalog_item_id),
        FOREIGN KEY(tenant_id,catalog_item_id) REFERENCES catalog_items(tenant_id,id));
      CREATE TABLE IF NOT EXISTS catalogue_options (
        id serial PRIMARY KEY,tenant_id integer NOT NULL REFERENCES tenants(id),product_id integer NOT NULL,catalog_item_id integer NOT NULL,inventory_item_id integer NOT NULL,
        label text NOT NULL DEFAULT 'Standard',consumption_quantity numeric(20,6) NOT NULL DEFAULT 1,sort_order integer NOT NULL DEFAULT 0,
        active boolean NOT NULL DEFAULT true,option_values jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(tenant_id,id),UNIQUE(tenant_id,catalog_item_id),UNIQUE(tenant_id,product_id,option_values),
        FOREIGN KEY(tenant_id,product_id) REFERENCES catalogue_products(tenant_id,id),
        FOREIGN KEY(tenant_id,catalog_item_id) REFERENCES catalog_items(tenant_id,id),FOREIGN KEY(tenant_id,inventory_item_id) REFERENCES inventory_items(tenant_id,id));
      CREATE INDEX IF NOT EXISTS catalogue_options_product_idx ON catalogue_options(tenant_id,product_id,sort_order,id);
      CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_tenant_woo_variation_unique ON catalog_items(tenant_id,woo_product_id,woo_variation_id) WHERE woo_product_id IS NOT NULL AND woo_variation_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS inventory_balances_unique ON inventory_balances(tenant_id,product_id,location_id);
      CREATE TABLE IF NOT EXISTS woocommerce_stock_location_assignments (
        tenant_id integer NOT NULL REFERENCES tenants(id),catalog_item_id integer NOT NULL,location_id integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,catalog_item_id),
        FOREIGN KEY(tenant_id,catalog_item_id) REFERENCES catalog_items(tenant_id,id),
        FOREIGN KEY(tenant_id,location_id) REFERENCES inventory_locations(tenant_id,id));
      CREATE OR REPLACE FUNCTION create_standard_option_for_catalog_item() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE product_key integer; item_key integer;
        BEGIN
          INSERT INTO catalogue_products (tenant_id,name) VALUES (NEW.tenant_id,NEW.name) RETURNING id INTO product_key;
          INSERT INTO inventory_items (tenant_id,catalog_item_id,base_unit) VALUES (NEW.tenant_id,NEW.id,COALESCE(NULLIF(NEW.stock_unit,'#'),'each')) RETURNING id INTO item_key;
          INSERT INTO catalogue_options (tenant_id,product_id,catalog_item_id,inventory_item_id) VALUES (NEW.tenant_id,product_key,NEW.id,item_key);
          RETURN NEW;
        END $$;
      DROP TRIGGER IF EXISTS catalog_item_standard_option ON catalog_items;
      CREATE TRIGGER catalog_item_standard_option AFTER INSERT ON catalog_items FOR EACH ROW EXECUTE FUNCTION create_standard_option_for_catalog_item();`);
    await pool.query(`ALTER TABLE woocommerce_stock_snapshots DROP CONSTRAINT IF EXISTS woocommerce_stock_snapshots_management_check;
      ALTER TABLE woocommerce_stock_snapshots ADD CONSTRAINT woocommerce_stock_snapshots_management_check
        CHECK (stock_management IN ('independent','variation','shared_parent','unmanaged'))`);
    await pool.query("DELETE FROM woocommerce_sync_jobs");
    const [tenant] = await db.insert(tenantsTable).values({ name: "Woo Sync Isolated Test", slug: `woo-sync-${Date.now()}`, status: "active" }).returning();
    tenantId = tenant!.id;
    const [user] = await db.insert(usersTable).values({ clerkId: `woo-sync-${Date.now()}`, email: "woo-test@example.invalid", role: "admin", tenantId, status: "approved", identityStatus: "verified", provisioningStatus: "provisioned" }).returning();
    userId = user!.id;
    await db.insert(tenantSettingsTable).values({ tenantId, publicBusinessName: "Woo Sync Test", appName: "Woo Sync Test", defaultCurrency: "USD" });
    await db.insert(adminSettingsTable).values({ tenantId, wcStoreUrl: "https://woocommerce.invalid", wcConsumerKey: encrypt("test-consumer-key"), wcConsumerSecret: encrypt("test-consumer-secret"), wcEnabled: true });
    const [location] = await db.insert(inventoryLocationsTable).values({ tenantId, type: "storefront", name: "Woo Test Location", isActive: true }).returning();
    locationId = location!.id;
    mockedFetch.mockImplementation(async (_url, path) => wooResponseForPath(path));
  }, 20_000);

  afterAll(async () => {
    mockedFetch.mockReset();
    await pool.end();
  });

  it("serializes concurrent enqueue, persists after request disconnect, and scopes status by tenant", async () => {
    const [first, concurrentA, concurrentB] = await Promise.all([
      enqueueWooSync(tenantId, userId), enqueueWooSync(tenantId, userId), enqueueWooSync(tenantId, userId),
    ]);
    expect(new Set([first.id, concurrentA.id, concurrentB.id]).size).toBe(1);
    expect([first.reused, concurrentA.reused, concurrentB.reused].filter(Boolean)).toHaveLength(2);
    const visible = await getTenantWooSyncJob(tenantId, first.id);
    expect(visible).toMatchObject({ id: first.id, state: "queued", attemptCount: 0 });
    expect(await getTenantWooSyncJob(tenantId + 100000, first.id)).toBeNull();

    await pool.query("UPDATE woocommerce_sync_jobs SET state='running',lease_until=now()-interval '1 second' WHERE id=$1", [first.id]);
    const summary = { parentsCreated: 0, parentsUpdated: 1, variantsCreated: 0, variantsUpdated: 0, skipped: 0, failed: 0,
      totalParents: 1, totalVariants: 0, errors: [] };
    const worked = await runWooSyncWorkerOnce(async (_tenant, progress) => { await progress?.(summary); return summary; });
    expect(worked).toBe(true);
    expect(await getTenantWooSyncJob(tenantId, first.id)).toMatchObject({ state: "succeeded", attemptCount: 1, updated: 1 });
  });

  it("imports 245 paginated products and two structured 3867 variants idempotently without changing inventory or order snapshots", async () => {
    const [parent] = await db.insert(catalogItemsTable).values({ tenantId, name: "Bottle Product 3867", category: "Apparel & Accessories", price: "5.00",
      sku: "PARENT-3867", isAvailable: false, isWooManaged: true, isLocalAlavont: false, alavontId: "wc_3867", wooProductId: "3867",
      metadata: { complianceHold: true, complianceReason: "Isolated compliance fixture", isVisible: true } }).returning();

    const first = await runWooCatalogSync(tenantId);
    expect(first.totalParents).toBe(245);
    expect(first.parentsCreated).toBe(244);
    expect(first.parentsUpdated).toBe(1);
    expect(first.variantsCreated).toBe(4);
    expect(first.totalVariants).toBe(4);
    expect(first.failed).toBe(0);
    const simpleSnapshot = (await pool.query("SELECT stock_management,managed_stock,stock_quantity FROM woocommerce_stock_snapshots WHERE tenant_id=$1 AND woo_product_id='4107' AND woo_variation_id IS NULL", [tenantId])).rows[0];
    expect(simpleSnapshot).toMatchObject({ stock_management: "independent", managed_stock: true, stock_quantity: "4.000000" });
    const [simpleProduct] = await db.select().from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.wooProductId, "4107")));
    expect(simpleProduct?.category).toBe("Apparel & Accessories");

    const variants = await db.select().from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.wooProductId, "3867"), sql`${catalogItemsTable.wooVariationId} IS NOT NULL`));
    expect(variants).toHaveLength(2);
    expect(variants.find(item => item.wooVariationId === "3875")).toMatchObject({ price: "9.00", compareAtPrice: "10.99", sku: null });
    expect(variants.find(item => item.wooVariationId === "3874")).toMatchObject({ price: "17.00", compareAtPrice: "18.99", sku: "BOTTLE-2OZ" });
    expect(variants.every(item => (item.metadata as Record<string, unknown>).complianceHold === true)).toBe(true);
    const options = await pool.query("SELECT option_values FROM catalogue_options WHERE tenant_id=$1 AND product_id=(SELECT product_id FROM catalogue_options WHERE tenant_id=$1 AND catalog_item_id=$2) AND catalog_item_id IN (SELECT id FROM catalog_items WHERE tenant_id=$1 AND woo_product_id='3867' AND woo_variation_id IS NOT NULL) ORDER BY option_values::text", [tenantId, parent!.id]);
    expect(options.rows.map(row => row.option_values)).toContainEqual({ "Bottle Size": "2oz" });
    expect(options.rows.map(row => row.option_values)).toContainEqual({ "Bottle Size": "4oz" });

    const [firstVariant] = variants.filter(item => item.wooVariationId === "3875");
    const [secondVariant] = variants.filter(item => item.wooVariationId === "3874");
    const [admin] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    await postInventoryMovementInTransaction({ tenantId, actor: { id: admin!.id, email: admin!.email, role: admin!.role }, entityType: "catalog",
      itemId: firstVariant!.id, locationId, movementType: "adjustment_increase", quantity: "3", unitCost: "0.50",
      sourceType: "isolated_test", reasonCode: "test", reasonText: "Isolated stock movement", idempotencyKey: `woo-test-${tenantId}-movement` });
    const [order] = await db.insert(ordersTable).values({ tenantId, customerId: userId, status: "submitted", paymentStatus: "paid", subtotal: "9.00", total: "9.00" }).returning();
    await db.insert(orderItemsTable).values({ orderId: order!.id, catalogItemId: firstVariant!.id, catalogItemName: firstVariant!.name,
      quantity: 1, unitPrice: "9.00", totalPrice: "9.00", variantSnapshot: { variantId: firstVariant!.id, wooVariationId: "3875", sku: null, options: { "Bottle Size": "4oz" } } });
    await db.insert(inventoryReservationsTable).values({ orderId: order!.id, catalogItemId: firstVariant!.id, locationId,
      quantity: "1", status: "reserved", idempotencyKey: `woo-test-${tenantId}-reservation`, expiresAt: new Date(Date.now() + 60_000) });
    const beforeMovementCount = Number((await pool.query("SELECT count(*)::int AS n FROM inventory_movements WHERE tenant_id=$1 AND catalog_item_id=ANY($2::int[])", [tenantId, [firstVariant!.id, secondVariant!.id]])).rows[0]!.n);
    const beforeBalances = await db.select().from(inventoryBalancesTable).where(eq(inventoryBalancesTable.tenantId, tenantId));
    expect(beforeBalances.find(row => row.productId === firstVariant!.id)?.quantityOnHand).toBe("3.000000");
    expect(beforeBalances.find(row => row.productId === secondVariant!.id)).toBeUndefined();

    variationSalePrice = "8.50";
    const second = await runWooCatalogSync(tenantId);
    expect(second.totalParents).toBe(245);
    expect(second.parentsCreated).toBe(0);
    expect(second.parentsUpdated).toBe(245);
    expect(second.variantsCreated).toBe(0);
    expect(second.variantsUpdated).toBe(4);
    expect(second.failed).toBe(0);
    const [afterVariant] = await db.select().from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.wooVariationId, "3875")));
    expect(afterVariant?.price).toBe("8.50");
    expect(afterVariant?.compareAtPrice).toBe("10.99");
    expect(await db.select({ id: catalogItemsTable.id }).from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.wooProductId, "3867")))).toHaveLength(3);
    expect(Number((await pool.query("SELECT count(*)::int AS n FROM inventory_movements WHERE tenant_id=$1 AND catalog_item_id=ANY($2::int[])", [tenantId, [firstVariant!.id, secondVariant!.id]])).rows[0]!.n)).toBe(beforeMovementCount);
    const afterBalances = await db.select().from(inventoryBalancesTable).where(eq(inventoryBalancesTable.tenantId, tenantId));
    expect(afterBalances.find(row => row.productId === firstVariant!.id)?.quantityOnHand).toBe("3.000000");
    expect(afterBalances.find(row => row.productId === secondVariant!.id)).toBeUndefined();
    expect((await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order!.id)))[0]?.variantSnapshot).toEqual({
      variantId: firstVariant!.id, wooVariationId: "3875", sku: null, options: { "Bottle Size": "4oz" },
    });
    expect((await db.select().from(inventoryReservationsTable).where(eq(inventoryReservationsTable.orderId, order!.id)))[0]).toMatchObject({
      catalogItemId: firstVariant!.id, status: "reserved", quantity: "1.000000",
    });
    const sharedStock = (await pool.query("SELECT stock_management,managed_stock,stock_quantity FROM woocommerce_stock_snapshots WHERE tenant_id=$1 AND woo_product_id='3421' AND woo_variation_id IS NULL", [tenantId])).rows[0];
    expect(sharedStock).toMatchObject({ stock_management: "shared_parent", managed_stock: true, stock_quantity: "5.000000" });
    const unmanaged = (await pool.query("SELECT managed_stock,stock_quantity FROM woocommerce_stock_snapshots WHERE tenant_id=$1 AND woo_product_id='3421' AND woo_variation_id='3423'", [tenantId])).rows[0];
    expect(unmanaged).toMatchObject({ managed_stock: false, stock_quantity: null });

    const beforeConcurrent = await db.select({ id: catalogItemsTable.id }).from(catalogItemsTable)
      .where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.wooProductId, "3867"), sql`${catalogItemsTable.wooVariationId} IS NOT NULL`));
    await Promise.all([runWooCatalogSync(tenantId, undefined, "3867"), runWooCatalogSync(tenantId, undefined, "3867")]);
    const afterConcurrent = await db.select({ id: catalogItemsTable.id }).from(catalogItemsTable)
      .where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.wooProductId, "3867"), sql`${catalogItemsTable.wooVariationId} IS NOT NULL`));
    expect(afterConcurrent).toEqual(beforeConcurrent);

    disableSecond3867Variation = true;
    await runWooCatalogSync(tenantId, undefined, "3867");
    disableSecond3867Variation = false;
    const disabled = await db.select({ isAvailable: catalogItemsTable.isAvailable }).from(catalogItemsTable)
      .where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.wooVariationId, "3874")));
    expect(disabled[0]?.isAvailable).toBe(false);

    includeSecond3867Variation = false;
    await runWooCatalogSync(tenantId, undefined, "3867");
    includeSecond3867Variation = true;
    const retired = await db.select({ id: catalogItemsTable.id, isAvailable: catalogItemsTable.isAvailable }).from(catalogItemsTable)
      .where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.wooVariationId, "3874")));
    expect(retired).toHaveLength(1);
    expect(retired[0]?.isAvailable).toBe(false);
    const retiredOption = (await pool.query("SELECT active FROM catalogue_options WHERE tenant_id=$1 AND catalog_item_id=$2", [tenantId, retired[0]!.id])).rows[0];
    expect(retiredOption.active).toBe(false);

    await pool.query("INSERT INTO woocommerce_stock_location_assignments (tenant_id,catalog_item_id,location_id) VALUES ($1,$2,$3)",
      [tenantId, firstVariant!.id, locationId]);
    const [secondLocation] = await db.insert(inventoryLocationsTable).values({ tenantId, type: "storefront", name: "Second Woo Test Location", isActive: true }).returning();
    await expect(pool.query("INSERT INTO woocommerce_stock_location_assignments (tenant_id,catalog_item_id,location_id) VALUES ($1,$2,$3)",
      [tenantId, firstVariant!.id, secondLocation!.id])).rejects.toMatchObject({ code: "23505" });
  }, 30_000);

  it("rolls back one parent and its variants when one variation fails, and sanitizes worker errors", async () => {
    mockedFetch.mockImplementation(async (_url, path) => {
      if (path.includes("system_status")) return response({ environment: { currency_code: "USD" } });
      if (path.includes("products?")) return response([{ id: 991001, name: "Rollback Fixture", type: "variable", status: "publish", price: "1.00", regular_price: "1.00", stock_status: "instock" }], 200, { "x-wp-totalpages": "1" });
      if (path.includes("/variations")) return response({ message: "upstream failure" }, 503);
      return response([]);
    });
    const failedImport = await runWooCatalogSync(tenantId);
    expect(failedImport.failed).toBe(1);
    expect(failedImport.errors).toEqual([{ productId: "991001", code: "upstream_unavailable" }]);
    expect(await db.select().from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.wooProductId, "991001")))).toHaveLength(0);

    const [queued] = await enqueueWooSync(tenantId, userId).then(value => [value]);
    await runWooSyncWorkerOnce(async () => { throw new Error("provider secret text must not persist"); });
    const job = await getTenantWooSyncJob(tenantId, queued!.id);
    expect(job).toMatchObject({ state: "interrupted", lastErrorCode: "sync_failed" });
    expect(JSON.stringify(job)).not.toContain("provider secret text");
  });

  it("retries an upstream rate limit with bounded requests", async () => {
    let statusCalls = 0;
    mockedFetch.mockImplementation(async (_url, path) => {
      if (path.includes("system_status")) {
        statusCalls++;
        if (statusCalls === 1) return response({ message: "rate limited" }, 429, { "retry-after": "0" });
        return response({ environment: { currency_code: "USD" } });
      }
      if (path === "/wp-json/wc/v3/products/3867") return response({ id: 3867, name: "Bottle Product 3867", type: "variable", status: "publish",
        price: "9.00", regular_price: "10.99", sale_price: "9.00", categories: [{ name: "Apparel & Accessories" }],
        catalog_visibility: "visible", stock_status: "instock", manage_stock: false, sku: "SKU-3867", images: [] });
      if (path.includes("/products/3867/variations")) return response([
        { id: 3875, status: "publish", price: "9.00", regular_price: "10.99", stock_status: "instock", manage_stock: true, stock_quantity: 10,
          attributes: [{ name: "Bottle Size", option: "4oz" }] },
        { id: 3874, status: "publish", price: "17.00", regular_price: "18.99", stock_status: "instock", manage_stock: true, stock_quantity: 10,
          attributes: [{ name: "Bottle Size", option: "2oz" }] },
      ]);
      return response([]);
    });
    const result = await runWooCatalogSync(tenantId, undefined, "3867");
    expect(statusCalls).toBe(2);
    expect(result).toMatchObject({ totalParents: 1, failed: 0, variantsUpdated: 2 });
  });
});
