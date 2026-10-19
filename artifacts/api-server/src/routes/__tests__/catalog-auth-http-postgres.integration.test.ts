import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import express from "express";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({ userId: "", sessionClaims: {} as Record<string, unknown> }));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({ userId: clerkState.userId, sessionClaims: clerkState.sessionClaims })),
  clerkClient: { users: { getUser: vi.fn(async () => { throw new Error("Unexpected Clerk API call in fixture"); }), updateUserMetadata: vi.fn(async () => ({})) } },
}));

const databaseUrl = process.env.MYORDER_CATALOG_COMPAT_DATABASE_URL;
const integrationSuite = databaseUrl ? describe : describe.skip;

integrationSuite("authenticated Catalog HTTP requests against disposable PostgreSQL 16", () => {
  let client: Client;
  let pool: { end: () => Promise<void> };
  let app: express.Express;

  async function requestAs(subject: string, path = "/api/catalog?limit=200&page=1&mode=alavont") {
    clerkState.userId = subject;
    clerkState.sessionClaims = { role: subject === "catalog-owner-fixture" ? "global_admin" : "user", status: "approved" };
    return supertest(app).get(path);
  }

  async function toggleDdlTripwire(enabled: boolean) {
    if (enabled) {
      await client.query(`CREATE OR REPLACE FUNCTION public.reject_request_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'request-time DDL is forbidden in this fixture'; END $$; CREATE EVENT TRIGGER reject_request_ddl ON ddl_command_start EXECUTE FUNCTION public.reject_request_ddl()`);
    } else {
      await client.query("DROP EVENT TRIGGER IF EXISTS reject_request_ddl; DROP FUNCTION IF EXISTS public.reject_request_ddl()");
    }
  }

  async function toggleDmlTripwire(enabled: boolean) {
    const tables = ["users", "tenants", "clerk_webhook_events", "catalog_items", "inventory_locations", "inventory_balances", "admin_settings", "orders", "order_items", "inventory_transaction_log"];
    if (!enabled) {
      for (const table of tables) await client.query(`DROP TRIGGER IF EXISTS reject_request_dml ON public."${table}"`);
      await client.query("DROP FUNCTION IF EXISTS public.reject_request_dml()");
      return;
    }
    await client.query("CREATE OR REPLACE FUNCTION public.reject_request_dml() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'request-time DML is forbidden in this fixture'; END $$");
    for (const table of tables) {
      await client.query(`CREATE TRIGGER reject_request_dml BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public."${table}" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_request_dml()`);
    }
  }

  async function createBaseSchema(db: typeof import("@workspace/db")) {
    const {
      tenantsTable, usersTable, clerkWebhookEventsTable, catalogItemsTable: catalogTable,
      inventoryLocationsTable, inventoryBalancesTable, adminSettingsTable,
    } = db;
    const tables = [tenantsTable, usersTable, clerkWebhookEventsTable, catalogTable, inventoryLocationsTable, inventoryBalancesTable, adminSettingsTable];
    for (const table of tables) {
      const config = getTableConfig(table);
      const definitions = config.columns.map((column) => {
        const type = column.getSQLType();
        const primary = column.primary ? " PRIMARY KEY" : "";
        const unique = column.isUnique ? " UNIQUE" : "";
        // Keep only primary/unique constraints in the compact runtime fixture;
        // seeded rows below explicitly satisfy all route-relevant invariants.
        // Optional columns remain nullable so omitted unrelated defaults do not
        // make this fixture accidentally stricter than the selected schema.
        return `"${column.name}" ${type}${primary}${unique}`;
      });
      await client.query(`CREATE TABLE public."${config.name}" (${definitions.join(", ")})`);
    }
    await client.query(`
      CREATE TABLE public.orders (id serial PRIMARY KEY, tenant_id integer NOT NULL);
      CREATE TABLE public.order_items (id serial PRIMARY KEY, order_id integer, catalog_item_id integer);
      CREATE TABLE public.inventory_transaction_log (id serial PRIMARY KEY, catalog_item_id integer);
      CREATE UNIQUE INDEX catalog_items_tenant_id_id_unique ON public.catalog_items(tenant_id, id);
      CREATE UNIQUE INDEX inventory_locations_tenant_id_id_unique ON public.inventory_locations(tenant_id, id);
      INSERT INTO public.tenants(id,name,slug,status) VALUES
        (1,'Fixture tenant one','fixture-one','active'),
        (2,'Fixture tenant two','fixture-two','active'),
        (3,'Fixture empty tenant','fixture-empty','active');
      INSERT INTO public.users
        (clerk_id,email,normalized_email,first_name,last_name,role,tenant_id,status,approved_by_clerk_id,approved_at,is_active,identity_status,provisioning_status,created_at,updated_at)
      VALUES
        ('catalog-owner-fixture','owner@fixture.invalid','owner@fixture.invalid','Test','Owner','user',1,'approved',NULL,NULL,true,'verified','active',now(),now()),
        ('catalog-pending-fixture','pending@fixture.invalid','pending@fixture.invalid','Test','Pending','user',1,'pending',NULL,NULL,true,'verified','active',now(),now()),
        ('catalog-member-fixture','member@fixture.invalid','member@fixture.invalid','Test','Member','user',1,'approved','catalog-owner-fixture',now(),true,'verified','active',now(),now()),
        ('catalog-global-fixture','global@fixture.invalid','global@fixture.invalid','Test','Global','global_admin',NULL,'approved','catalog-owner-fixture',now(),true,'verified','active',now(),now());
      INSERT INTO public.catalog_items
        (tenant_id,name,category,sku,price,is_available,is_taxable,alavont_in_stock,is_local_alavont,is_woo_managed,metadata,created_at,updated_at)
      VALUES
        (1,'Tenant one item','fixture','ONE',3.50,true,true,true,true,false,'{}',now(),now()),
        (2,'Tenant two item','fixture','TWO',4.50,true,true,true,true,false,'{}',now(),now());
      INSERT INTO public.inventory_locations(tenant_id,type,name,is_active) VALUES (1,'backstock','Location one',true),(2,'backstock','Location two',true);
      INSERT INTO public.inventory_balances(tenant_id,product_id,location_id,quantity_on_hand,inventory_kind,is_sellable,quarantined_at)
      VALUES (1,1,1,8,'sellable_catalog',true,NULL),(2,2,2,9,'sellable_catalog',true,NULL);
    `);
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("MYORDER_CATALOG_COMPAT_DATABASE_URL is required");
    const parsed = new URL(databaseUrl);
    if (!/^(localhost|127\.0\.0\.1|::1)$/.test(parsed.hostname) || !/^myorder_catalog_compat_test$/.test(decodeURIComponent(parsed.pathname.slice(1)))) {
      throw new Error("Refusing a non-disposable or non-local Catalog integration database");
    }
    client = new Client({ connectionString: databaseUrl, ssl: false });
    await client.connect();
    const identity = await client.query<{ database_name: string; server_version_num: number }>("SELECT current_database() AS database_name, current_setting('server_version_num')::integer AS server_version_num");
    const existing = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_tables WHERE schemaname='public'");
    if (identity.rows[0]?.database_name !== "myorder_catalog_compat_test" || Number(identity.rows[0]?.server_version_num) < 160000 || Number(identity.rows[0]?.server_version_num) >= 170000 || Number(existing.rows[0]?.count) !== 0) {
      throw new Error("Expected an empty disposable PostgreSQL 16 Catalog database");
    }
    process.env.DATABASE_URL = databaseUrl;
    process.env.MYORDER_OWNER_CLERK_ID = "catalog-owner-fixture";
    const db = await import("@workspace/db");
    pool = db.pool;
    await createBaseSchema(db);
    const legacyReservations = await readFile(
      new URL("../../../../../lib/db/migrations/202607060001_inventory_reservations.sql", import.meta.url),
      "utf8",
    );
    await client.query(legacyReservations);
    const { default: catalogRouter } = await import("../catalog");
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as typeof req & { log: { info: () => void } }).log = { info: () => undefined }; next(); });
    app.use("/api", catalogRouter);
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "fixture_internal_error" });
    });
    await toggleDmlTripwire(true);
    await toggleDdlTripwire(true);
  }, 20_000);

  afterAll(async () => {
    if (client) {
      await toggleDdlTripwire(false).catch(() => undefined);
      await toggleDmlTripwire(false).catch(() => undefined);
      await client.end();
    }
    await pool?.end();
  });

  it("serves populated and empty Catalogs against the pre-0070 schema without request DDL", async () => {
    const populated = await requestAs("catalog-owner-fixture");
    expect(populated.status, JSON.stringify(populated.body)).toBe(200);
    expect(populated.body.items.map((row: { name: string }) => row.name)).toEqual(["Tenant one item"]);
    expect(populated.body.items[0].sellableProduct).toBeUndefined();
    expect(populated.body.items[0].stockQuantity).toBe(8);

    const empty = await requestAs("catalog-global-fixture", "/api/catalog?tenantId=3&limit=200&page=1&mode=alavont");
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body.items).toEqual([]);
    expect(empty.body.total).toBe(0);
  });

  it("rejects pending users, unauthorized tenant selection, and tenantless global administrators", async () => {
    expect((await requestAs("catalog-pending-fixture")).status).toBe(403);
    expect((await requestAs("catalog-member-fixture", "/api/catalog?tenantId=2&limit=200&page=1&mode=alavont")).status).toBe(403);
    const tenantless = await requestAs("catalog-global-fixture");
    expect(tenantless.status).toBe(403);
    expect(tenantless.body.error).toMatch(/Explicit tenantId/);
    const selected = await requestAs("catalog-global-fixture", "/api/catalog?tenantId=1&limit=200&page=1&mode=alavont");
    expect(selected.status).toBe(200);
    expect(selected.body.items.every((row: { tenantId: number }) => row.tenantId === 1)).toBe(true);
  });

  it("fails explicitly on partial 0070 schema rather than downgrading it to absent", async () => {
    await toggleDdlTripwire(false);
    await client.query("CREATE TABLE public.catalogue_products(id integer)");
    await toggleDdlTripwire(true);
    const response = await requestAs("catalog-owner-fixture");
    expect(response.status).toBe(500);
    expect(response.body.error).toBe("fixture_internal_error");
    await toggleDdlTripwire(false);
    await client.query("DROP TABLE public.catalogue_products");
    await client.query("ALTER TABLE public.order_items ADD COLUMN option_id integer");
    await toggleDdlTripwire(true);
    const partialColumnOnly = await requestAs("catalog-owner-fixture");
    expect(partialColumnOnly.status).toBe(500);
    expect(partialColumnOnly.body.error).toBe("fixture_internal_error");
    await toggleDdlTripwire(false);
    await client.query("ALTER TABLE public.order_items DROP COLUMN option_id");
    await toggleDdlTripwire(true);
  });

  it("uses full 0070 enrichment tenant-scoped and propagates unrelated SQL errors", async () => {
    await toggleDdlTripwire(false);
    const migration = await readFile(new URL("../../../../../lib/db/drizzle/0070_catalogue_products_options_reorder.sql", import.meta.url), "utf8");
    await client.query(migration);
    await toggleDdlTripwire(true);

    const populated = await requestAs("catalog-owner-fixture");
    expect(populated.status, JSON.stringify(populated.body)).toBe(200);
    expect(populated.body.items).toHaveLength(1);
    expect(populated.body.items[0].sellableProduct).toBeDefined();
    expect(populated.body.items[0].sellableProduct.options[0].catalogItemId).toBe(1);
    const memberDenied = await requestAs("catalog-member-fixture", "/api/catalog?tenantId=2&limit=200&page=1&mode=alavont");
    expect(memberDenied.status).toBe(403);
    const foreign = await requestAs("catalog-global-fixture", "/api/catalog?tenantId=3&limit=200&page=1&mode=alavont");
    expect(foreign.status).toBe(200);
    expect(foreign.body.items).toEqual([]);

    await toggleDdlTripwire(false);
    await toggleDmlTripwire(false);
    await client.query("UPDATE public.catalog_items SET metadata = '{\"archived\":\"not-a-boolean\"}'::jsonb WHERE id=1");
    await toggleDmlTripwire(true);
    await toggleDdlTripwire(true);
    const brokenEnrichment = await requestAs("catalog-owner-fixture");
    expect(brokenEnrichment.status).toBe(500);
    expect(brokenEnrichment.body.error).toBe("fixture_internal_error");
  });

  it("performs no schema mutation on the authenticated route path", async () => {
    await toggleDdlTripwire(false);
    await toggleDmlTripwire(false);
    await client.query("UPDATE public.catalog_items SET metadata='{}'::jsonb WHERE id=1");
    await toggleDmlTripwire(true);
    await toggleDdlTripwire(true);
    const before = await client.query<{ name: string; column_count: number }>(`SELECT c.relname AS name, (SELECT count(*)::integer FROM information_schema.columns i WHERE i.table_schema='public' AND i.table_name=c.relname) AS column_count FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','v','m') ORDER BY c.relname`);
    const response = await requestAs("catalog-owner-fixture");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await client.query<{ name: string; column_count: number }>(`SELECT c.relname AS name, (SELECT count(*)::integer FROM information_schema.columns i WHERE i.table_schema='public' AND i.table_name=c.relname) AS column_count FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','v','m') ORDER BY c.relname`);
    expect(after.rows).toEqual(before.rows);
  });
});
