import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.MYORDER_CATALOG_COMPAT_DATABASE_URL;
const describeIfDatabase = describe.skipIf(!databaseUrl);

describeIfDatabase("PostgreSQL Catalog optional-schema compatibility", () => {
  let client: Client;
  let dbPool: { end: () => Promise<void> } | undefined;
  let dbModule: typeof import("@workspace/db");
  let hasSellableProductSchema: () => Promise<boolean>;
  let loadSellableProducts: (tenantId: number) => Promise<Array<{ tenantId: number; options: unknown[] }>>;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("MYORDER_CATALOG_COMPAT_DATABASE_URL is required");
    const parsed = new URL(databaseUrl);
    const databaseName = decodeURIComponent(parsed.pathname.slice(1));
    if (!/^(localhost|127\.0\.0\.1|::1)$/.test(parsed.hostname) || !/^myorder_catalog_compat_test(?:_[a-z0-9]+)?$/.test(databaseName)) {
      throw new Error("Catalog compatibility integration tests require a disposable localhost database named myorder_catalog_compat_test");
    }

    client = new Client({ connectionString: databaseUrl, ssl: false });
    await client.connect();
    const identity = await client.query<{ database_name: string; server_version_num: number }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num')::integer AS server_version_num",
    );
    if (identity.rows[0]?.database_name !== databaseName || (identity.rows[0]?.server_version_num ?? 0) < 160000 || (identity.rows[0]?.server_version_num ?? 0) >= 170000) {
      throw new Error("Catalog compatibility integration tests require PostgreSQL 16 in the disposable database");
    }
    const existingTables = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'",
    );
    if (Number(existingTables.rows[0]?.count) !== 0) {
      throw new Error("Refusing to modify a non-empty disposable Catalog compatibility database");
    }

    process.env.DATABASE_URL = databaseUrl;
    dbModule = await import("@workspace/db");
    dbPool = dbModule.pool;
    ({ hasSellableProductSchema, loadSellableProducts } = await import("../../lib/catalogueSellable"));

    await client.query(`
      CREATE TABLE tenants (id serial PRIMARY KEY);
      CREATE TABLE catalog_items (
        id serial PRIMARY KEY,
        tenant_id integer NOT NULL REFERENCES tenants(id),
        name text NOT NULL,
        stock_unit text NOT NULL DEFAULT '#',
        sku text,
        price numeric(10, 2) NOT NULL DEFAULT 0,
        is_available boolean NOT NULL DEFAULT true,
        alavont_in_stock boolean NOT NULL DEFAULT true,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (tenant_id, id)
      );
      CREATE TABLE inventory_locations (
        id serial PRIMARY KEY,
        tenant_id integer NOT NULL REFERENCES tenants(id),
        UNIQUE (tenant_id, id)
      );
      CREATE TABLE inventory_balances (
        id serial PRIMARY KEY,
        tenant_id integer NOT NULL,
        product_id integer NOT NULL,
        quantity_on_hand numeric(20, 6) NOT NULL DEFAULT 0,
        FOREIGN KEY (tenant_id, product_id) REFERENCES catalog_items(tenant_id, id)
      );
      CREATE TABLE orders (id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES tenants(id));
      CREATE TABLE order_items (id serial PRIMARY KEY, order_id integer, catalog_item_id integer);
      CREATE TABLE inventory_transaction_log (catalog_item_id integer);
      INSERT INTO tenants (id) VALUES (1), (2);
      INSERT INTO catalog_items (tenant_id, name, sku, price) VALUES
        (1, 'Synthetic tenant one item', 'TEST-ONE', 1.00),
        (2, 'Synthetic tenant two item', 'TEST-TWO', 2.00);
    `);
    // This table predates 0070. It must not, by itself, make the optional
    // Catalog enrichment appear partially installed.
    const legacyReservations = await readFile(
      new URL("../../../../../lib/db/migrations/202607060001_inventory_reservations.sql", import.meta.url),
      "utf8",
    );
    await client.query(legacyReservations);
  }, 20_000);

  afterAll(async () => {
    if (client) {
      await client.query(`
        DROP TABLE IF EXISTS catalogue_options, inventory_reorder_policies, inventory_reservations,
          inventory_items, catalogue_products, inventory_transaction_log, order_items, orders,
          inventory_balances, inventory_locations, catalog_items, tenants CASCADE;
        DROP FUNCTION IF EXISTS block_live_inventory_model_change() CASCADE;
        DROP FUNCTION IF EXISTS create_standard_option_for_catalogue_item() CASCADE;
      `).catch(() => undefined);
      await client.end();
    }
    await dbPool?.end();
  });

  it("supports the pre-0070 legacy reservations table without enrichment", async () => {
    expect(await hasSellableProductSchema()).toBe(false);
    const reservation = await client.query<{ has_order_item_id: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='inventory_reservations' AND column_name='order_item_id') AS has_order_item_id",
    );
    expect(reservation.rows[0]?.has_order_item_id).toBe(false);
  });

  it("rejects a partial 0070 schema rather than hiding an incomplete migration", async () => {
    await client.query("CREATE TABLE catalogue_products (id integer)");
    await expect(hasSellableProductSchema()).rejects.toThrow("Optional sellable catalogue schema is incomplete");
    await client.query("DROP TABLE catalogue_products");
  });

  it("uses the actual 0070 migration when present and keeps enrichment tenant-scoped", async () => {
    const migration = await readFile(new URL("../../../../../lib/db/drizzle/0070_catalogue_products_options_reorder.sql", import.meta.url), "utf8");
    await client.query(migration);
    expect(await hasSellableProductSchema()).toBe(true);

    const tenantOne = await loadSellableProducts(1);
    const tenantTwo = await loadSellableProducts(2);
    expect(tenantOne).toHaveLength(1);
    expect(tenantOne[0]?.tenantId).toBe(1);
    expect(tenantOne[0]?.options).toHaveLength(1);
    expect(tenantTwo).toHaveLength(1);
    expect(tenantTwo[0]?.tenantId).toBe(2);
  }, 20_000);

  it("rejects a required column missing from an otherwise complete 0070 schema", async () => {
    await client.query("ALTER TABLE public.catalogue_products DROP COLUMN active");
    try {
      await expect(hasSellableProductSchema()).rejects.toThrow("Optional sellable catalogue schema is incomplete");
    } finally {
      await client.query("ALTER TABLE public.catalogue_products ADD COLUMN active boolean NOT NULL DEFAULT true");
    }
  });

  it("propagates an unexpected metadata-query failure", async () => {
    const executeSpy = vi.spyOn(dbModule.db, "execute").mockRejectedValueOnce(new Error("fixture metadata query failure"));
    try {
      await expect(hasSellableProductSchema()).rejects.toThrow("fixture metadata query failure");
    } finally {
      executeSpy.mockRestore();
    }
  });

  it("propagates an unexpected enrichment-query failure", async () => {
    const execute = dbModule.db.execute.bind(dbModule.db);
    const executeSpy = vi.spyOn(dbModule.db, "execute");
    executeSpy.mockImplementationOnce((...args) => execute(...args));
    executeSpy.mockRejectedValueOnce(new Error("fixture enrichment query failure"));
    try {
      await expect(loadSellableProducts(1)).rejects.toThrow("fixture enrichment query failure");
    } finally {
      executeSpy.mockRestore();
    }
  });
});
