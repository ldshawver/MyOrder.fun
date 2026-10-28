import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.MYORDER_ACCOUNTING_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("shift earning ledger PostgreSQL migration", () => {
  const schema = `shift_earnings_${randomUUID().replaceAll("-", "")}`;
  let client: Client;

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.pathname.includes("myorder_p0_owner_approval_ci")) {
      throw new Error("Shift earning integration tests require the disposable CI PostgreSQL database");
    }
    client = new Client({ connectionString: databaseUrl, ssl: false });
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE tenants (id serial PRIMARY KEY);
      CREATE TABLE users (id serial PRIMARY KEY, tenant_id integer NOT NULL, CONSTRAINT users_tenant_id_id_unique UNIQUE (tenant_id,id));
      CREATE TABLE lab_tech_shifts (id serial PRIMARY KEY, tenant_id integer NOT NULL, tech_id integer NOT NULL, CONSTRAINT lab_tech_shifts_tenant_id_id_unique UNIQUE (tenant_id,id));
      CREATE TABLE shift_closeout_packages (id serial PRIMARY KEY, tenant_id integer NOT NULL, shift_id integer NOT NULL);
      CREATE TABLE catalog_items (id serial PRIMARY KEY, tenant_id integer NOT NULL);
      CREATE TABLE order_items (id serial PRIMARY KEY, order_id integer NOT NULL);
      CREATE TABLE uber_delivery_quotes (id text PRIMARY KEY, status text NOT NULL DEFAULT 'quoted', expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), consumed_at timestamptz);
    `);
    const here = dirname(fileURLToPath(import.meta.url));
    const migration = await readFile(resolve(here, "../../../../../lib/db/migrations/202610280001_csr_delivery_closeout_accounting.sql"), "utf8");
    await client.query(migration);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });

  it("enforces explicit product and immutable order eligibility values", async () => {
    await expect(client.query("INSERT INTO catalog_items (tenant_id,commission_eligibility) VALUES (1,'fuzzy-membership-name')")).rejects.toMatchObject({ code: "23514" });
    await client.query("INSERT INTO catalog_items (tenant_id,commission_eligibility) VALUES (1,'membership')");
    await client.query("INSERT INTO order_items (order_id,commission_eligibility_snapshot,commission_gross_amount,commission_discount_amount) VALUES (1,'membership',20,5)");
    await client.query("UPDATE catalog_items SET commission_eligibility='eligible'");
    const result = await client.query("SELECT commission_eligibility_snapshot,gross_amount,discount_amount FROM (SELECT commission_eligibility_snapshot,commission_gross_amount AS gross_amount,commission_discount_amount AS discount_amount FROM order_items) snapshot");
    expect(result.rows[0]).toMatchObject({ commission_eligibility_snapshot: "membership", gross_amount: "20.00", discount_amount: "5.00" });
  });

  it("makes retried earning settlement idempotent per tenant and source", async () => {
    await client.query("INSERT INTO tenants (id) VALUES (1); INSERT INTO users (id,tenant_id) VALUES (1,1); INSERT INTO lab_tech_shifts (id,tenant_id,tech_id) VALUES (1,1,1); INSERT INTO shift_closeout_packages (id,tenant_id,shift_id) VALUES (1,1,1)");
    await client.query("INSERT INTO shift_earning_lines (tenant_id,closeout_package_id,shift_id,csr_user_id,kind,amount,source_key) VALUES (1,1,1,1,'customer_tip',4.25,'order:7:customer_tip')");
    await expect(client.query("INSERT INTO shift_earning_lines (tenant_id,closeout_package_id,shift_id,csr_user_id,kind,amount,source_key) VALUES (1,1,1,1,'customer_tip',4.25,'order:7:customer_tip')")).rejects.toMatchObject({ code: "23505" });
  });
});
