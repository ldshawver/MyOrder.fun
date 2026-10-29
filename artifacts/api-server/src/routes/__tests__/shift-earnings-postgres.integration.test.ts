import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dbRoot = resolve(here, "../../../../../lib/db");
const migrationPath = resolve(dbRoot, "drizzle/0080_csr_delivery_closeout_accounting.sql");
const migration = readFileSync(migrationPath, "utf8");
const journal = JSON.parse(readFileSync(resolve(dbRoot, "drizzle/meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };

it("keeps closeout accounting schema in the verified canonical migration journal", () => {
  const entry = journal.entries.find(item => item.tag === "0080_csr_delivery_closeout_accounting");
  expect(entry).toMatchObject({ idx: 54, tag: "0080_csr_delivery_closeout_accounting" });
  expect(createHash("sha256").update(migration).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  expect(existsSync(resolve(dbRoot, "migrations/202610280001_csr_delivery_closeout_accounting.sql"))).toBe(false);
});

const databaseUrl = process.env.MYORDER_ACCOUNTING_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("shift earning ledger PostgreSQL migration", () => {
  const schema = `shift_earnings_${randomUUID().replaceAll("-", "")}`;
  let client: Client;
  let concurrentClient: Client;

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.pathname.includes("myorder_p0_owner_approval_ci")) {
      throw new Error("Shift earning integration tests require the disposable CI PostgreSQL database");
    }
    client = new Client({ connectionString: databaseUrl, ssl: false });
    concurrentClient = new Client({ connectionString: databaseUrl, ssl: false });
    await Promise.all([client.connect(), concurrentClient.connect()]);
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    await concurrentClient.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE tenants (id serial PRIMARY KEY);
      CREATE TABLE users (id serial PRIMARY KEY, tenant_id integer NOT NULL, CONSTRAINT users_tenant_id_id_unique UNIQUE (tenant_id,id));
      CREATE TABLE lab_tech_shifts (id serial PRIMARY KEY, tenant_id integer NOT NULL, tech_id integer NOT NULL, CONSTRAINT lab_tech_shifts_tenant_id_id_unique UNIQUE (tenant_id,id));
      CREATE TABLE shift_closeout_packages (id serial PRIMARY KEY, tenant_id integer NOT NULL, shift_id integer NOT NULL, location_id integer, supervisor_user_id integer NOT NULL, idempotency_key text NOT NULL, snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb, source_max_updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id,shift_id), UNIQUE (tenant_id,idempotency_key));
      CREATE TABLE commission_snapshots (id serial PRIMARY KEY, tenant_id integer NOT NULL, closeout_package_id integer NOT NULL, shift_id integer NOT NULL, csr_user_id integer NOT NULL, qualifying_sales numeric(12,2) NOT NULL DEFAULT 0, commission_basis numeric(12,2) NOT NULL DEFAULT 0, commission_rate numeric(9,6) NOT NULL DEFAULT 0, adjustments numeric(12,2) NOT NULL DEFAULT 0, commission_amount numeric(12,2) NOT NULL DEFAULT 0, rule_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT commission_snapshots_tenant_package_user_unique UNIQUE (tenant_id,closeout_package_id,csr_user_id), FOREIGN KEY (closeout_package_id) REFERENCES shift_closeout_packages(id), FOREIGN KEY (tenant_id,shift_id) REFERENCES lab_tech_shifts(tenant_id,id), FOREIGN KEY (tenant_id,csr_user_id) REFERENCES users(tenant_id,id));
      CREATE TABLE orders (id serial PRIMARY KEY, tenant_id integer NOT NULL, CONSTRAINT orders_tenant_id_id_unique UNIQUE (tenant_id,id));
      -- Simulate the earlier unjournaled table: the migration must replace its
      -- cross-tenant-prone package FK rather than assuming the table is absent.
      CREATE TABLE shift_earning_lines (id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES tenants(id), closeout_package_id integer NOT NULL REFERENCES shift_closeout_packages(id), shift_id integer NOT NULL, csr_user_id integer NOT NULL, kind text NOT NULL CHECK (kind IN ('product_commission','customer_tip','csr_delivery','house_delivery','uber_provider_delivery')), amount numeric(12,2) NOT NULL CHECK (amount >= 0), source_key text NOT NULL, source_order_id integer, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT shift_earning_lines_shift_fk FOREIGN KEY (tenant_id,shift_id) REFERENCES lab_tech_shifts(tenant_id,id), CONSTRAINT shift_earning_lines_csr_fk FOREIGN KEY (tenant_id,csr_user_id) REFERENCES users(tenant_id,id), CONSTRAINT shift_earning_lines_tenant_source_unique UNIQUE (tenant_id,source_key));
      CREATE TABLE catalog_items (id serial PRIMARY KEY, tenant_id integer NOT NULL);
      CREATE TABLE order_items (id serial PRIMARY KEY, order_id integer NOT NULL);
      CREATE TABLE uber_delivery_quotes (id text PRIMARY KEY, status text NOT NULL DEFAULT 'quoted', expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), consumed_at timestamptz, fee_cents integer NOT NULL DEFAULT 500, currency text NOT NULL DEFAULT 'USD');
      CREATE TABLE uber_delivery_fulfillments (id serial PRIMARY KEY, quote_id text NOT NULL REFERENCES uber_delivery_quotes(id), request_state text NOT NULL, provider_delivery_id text);
      CREATE FUNCTION reject_immutable_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE='55000'; END $$;
      INSERT INTO tenants (id) VALUES (1),(2);
      INSERT INTO users (id,tenant_id) VALUES (1,1),(2,2);
      INSERT INTO orders (id,tenant_id) VALUES (1,1),(2,2);
      INSERT INTO lab_tech_shifts (id,tenant_id,tech_id) VALUES (1,1,1),(2,2,2),(3,1,1);
      INSERT INTO shift_closeout_packages (id,tenant_id,shift_id,supervisor_user_id,idempotency_key) VALUES (1,1,1,1,'seed-a'),(2,2,2,2,'seed-b');
      INSERT INTO uber_delivery_quotes (id,status,expires_at,consumed_at) VALUES
        ('active-no-eta','quoted',now()+interval '1 day',NULL),
        ('expired-no-eta','expired',now()-interval '1 day',NULL),
        ('consumed-no-eta','consumed',now()-interval '1 day',now()-interval '2 hours');
      INSERT INTO uber_delivery_fulfillments (quote_id,request_state,provider_delivery_id) VALUES ('consumed-no-eta','delivery_created','uber-delivery-1');
    `);
    await client.query(migration);
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await Promise.all([client.end(), concurrentClient.end()]);
    }
  });

  it("expires legacy active quotes that cannot prove ETA while preserving consumed deliveries without synthetic ETA", async () => {
    const quotes = await client.query("SELECT id,status,dropoff_eta FROM uber_delivery_quotes ORDER BY id");
    expect(quotes.rows).toEqual([
      { id: "active-no-eta", status: "expired", dropoff_eta: null },
      { id: "consumed-no-eta", status: "consumed", dropoff_eta: null },
      { id: "expired-no-eta", status: "expired", dropoff_eta: null },
    ]);
    const fulfillment = await client.query("SELECT request_state,provider_delivery_id FROM uber_delivery_fulfillments WHERE quote_id='consumed-no-eta'");
    expect(fulfillment.rows).toEqual([{ request_state: "delivery_created", provider_delivery_id: "uber-delivery-1" }]);
    const etaColumn = await client.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='uber_delivery_quotes' AND column_name='dropoff_eta'", [schema]);
    expect(etaColumn.rows).toEqual([{ is_nullable: "YES" }]);
  });

  it("enforces eligibility snapshots and tenant-composite closeout references", async () => {
    await expect(client.query("INSERT INTO catalog_items (tenant_id,commission_eligibility) VALUES (1,'fuzzy-membership-name')")).rejects.toMatchObject({ code: "23514" });
    await client.query("INSERT INTO catalog_items (tenant_id,commission_eligibility) VALUES (1,'membership')");
    await client.query("INSERT INTO order_items (order_id,commission_eligibility_snapshot,commission_gross_amount,commission_discount_amount) VALUES (1,'membership',20,5)");
    await expect(client.query("INSERT INTO order_items (order_id,commission_eligibility_snapshot,commission_gross_amount,commission_discount_amount) VALUES (1,'eligible',10,11)")).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("INSERT INTO order_items (order_id,commission_eligibility_snapshot,commission_gross_amount,commission_discount_amount) VALUES (1,'unknown',10,0)")).rejects.toMatchObject({ code: "23514" });
    await client.query("UPDATE catalog_items SET commission_eligibility='eligible'");
    const result = await client.query("SELECT commission_eligibility_snapshot,commission_gross_amount,commission_discount_amount FROM order_items");
    expect(result.rows[0]).toMatchObject({ commission_eligibility_snapshot: "membership", commission_gross_amount: "20.00", commission_discount_amount: "5.00" });

    const values = "(1,2,1,1,'customer_tip',4.25,'tenant-a-cross-package')";
    await expect(client.query(`INSERT INTO shift_earning_lines (tenant_id,closeout_package_id,shift_id,csr_user_id,kind,amount,source_key) VALUES ${values}`)).rejects.toMatchObject({ code: "23503" });
    await expect(client.query("INSERT INTO commission_snapshots (tenant_id,closeout_package_id,shift_id,csr_user_id) VALUES (1,2,1,1)")).rejects.toMatchObject({ code: "23503" });
    await expect(client.query("INSERT INTO shift_commission_order_snapshots (tenant_id,closeout_package_id,shift_id,csr_user_id,order_id,commission_basis,commission_rate,commission_amount) VALUES (1,1,1,1,2,10,0.15,1.5)")).rejects.toMatchObject({ code: "23503" });
    await expect(client.query("INSERT INTO shift_earning_lines (tenant_id,closeout_package_id,shift_id,csr_user_id,kind,amount,source_key,source_order_id) VALUES (1,1,1,1,'customer_tip',4.25,'tenant-a-cross-order',2)")).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps earning rows unique, tenant-safe, and immutable", async () => {
    await client.query("INSERT INTO shift_earning_lines (tenant_id,closeout_package_id,shift_id,csr_user_id,kind,amount,source_key) VALUES (1,1,1,1,'customer_tip',4.25,'order:7:customer_tip')");
    await expect(client.query("INSERT INTO shift_earning_lines (tenant_id,closeout_package_id,shift_id,csr_user_id,kind,amount,source_key) VALUES (1,1,1,1,'customer_tip',4.25,'order:7:customer_tip')")).rejects.toMatchObject({ code: "23505" });
    await expect(client.query("UPDATE shift_earning_lines SET amount=0 WHERE source_key='order:7:customer_tip'")).rejects.toMatchObject({ code: "55000" });
  });

  it("serializes simultaneous closeout persistence into one package and one set of ledger rows", async () => {
    const settle = async (connection: Client) => {
      await connection.query("BEGIN");
      const pkg = await connection.query("INSERT INTO shift_closeout_packages (tenant_id,shift_id,supervisor_user_id,idempotency_key) VALUES (1,3,1,'shift-closeout:1:3') ON CONFLICT (tenant_id,shift_id) DO NOTHING RETURNING id");
      const selected = pkg.rows[0] ?? (await connection.query("SELECT id FROM shift_closeout_packages WHERE tenant_id=1 AND shift_id=3")).rows[0];
      await connection.query("INSERT INTO commission_snapshots (tenant_id,closeout_package_id,shift_id,csr_user_id) VALUES (1,$1,3,1) ON CONFLICT (tenant_id,closeout_package_id,csr_user_id) DO NOTHING", [selected.id]);
      await connection.query("INSERT INTO shift_earning_lines (tenant_id,closeout_package_id,shift_id,csr_user_id,kind,amount,source_key) VALUES (1,$1,3,1,'product_commission',10,'shift:3:product_commission') ON CONFLICT (tenant_id,source_key) DO NOTHING", [selected.id]);
      await connection.query("COMMIT");
      return Number(selected.id);
    };
    const [a, b] = await Promise.all([settle(client), settle(concurrentClient)]);
    expect(a).toBe(b);
    const counts = await client.query("SELECT (SELECT count(*) FROM shift_closeout_packages WHERE tenant_id=1 AND shift_id=3)::int AS packages, (SELECT count(*) FROM commission_snapshots WHERE tenant_id=1 AND shift_id=3)::int AS snapshots, (SELECT count(*) FROM shift_earning_lines WHERE tenant_id=1 AND shift_id=3)::int AS lines");
    expect(counts.rows[0]).toEqual({ packages: 1, snapshots: 1, lines: 1 });
  });
});
