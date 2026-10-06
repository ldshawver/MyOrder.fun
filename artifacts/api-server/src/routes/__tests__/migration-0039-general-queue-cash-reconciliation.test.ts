import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Client } = pg;
const enabled = process.env.RUN_MIGRATION_0039_E2E === "1";
const migrationDescribe = enabled ? describe : describe.skip;
const repoRoot = resolve(import.meta.dirname, "../../../../..");
const migration0038Path = resolve(repoRoot, "lib/db/drizzle/0038_general_queue_cash_sessions.sql");
const migrationSql = readFileSync(resolve(repoRoot, "lib/db/drizzle/0039_general_queue_cash_schema_reconciliation.sql"), "utf8");
const frozen0038Hash = "44028d841986512f0d7a348bd86db350b5ec3be52bf4de95730261f4776105fc";

const original0038State = `
CREATE TABLE tenants(id serial PRIMARY KEY);
CREATE TABLE users(id serial PRIMARY KEY, tenant_id integer REFERENCES tenants(id));
CREATE TABLE csr_boxes(id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES tenants(id), is_active boolean NOT NULL DEFAULT true);
CREATE TABLE inventory_locations(id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES tenants(id), csr_box_id integer REFERENCES csr_boxes(id), name text NOT NULL DEFAULT 'Location', is_active boolean NOT NULL DEFAULT true);
CREATE TABLE admin_settings(id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES tenants(id));
CREATE TABLE orders(id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES tenants(id));
CREATE TABLE lab_tech_shifts(id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES tenants(id));
CREATE TABLE general_queue_cash_sessions(
 id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES tenants(id), location_id integer NOT NULL REFERENCES inventory_locations(id),
 register_box_id integer NOT NULL REFERENCES csr_boxes(id), status text NOT NULL DEFAULT 'open', opened_by_user_id integer NOT NULL REFERENCES users(id),
 opened_at timestamptz NOT NULL DEFAULT now(), opening_balance numeric(10,2) NOT NULL DEFAULT 0, closed_by_user_id integer REFERENCES users(id),
 closed_at timestamptz, closing_balance numeric(10,2), expected_balance numeric(10,2), difference_amount numeric(10,2), payment_totals_json json DEFAULT '{}', summary json DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT general_queue_cash_sessions_status_check CHECK(status IN ('open','closed'))
);
CREATE UNIQUE INDEX general_queue_cash_sessions_open_register_uq ON general_queue_cash_sessions(tenant_id,location_id,register_box_id) WHERE status='open';
CREATE TABLE general_queue_cash_session_participants(session_id integer NOT NULL REFERENCES general_queue_cash_sessions(id), user_id integer NOT NULL REFERENCES users(id), joined_at timestamptz NOT NULL DEFAULT now(), joined_by_user_id integer NOT NULL REFERENCES users(id), left_at timestamptz, PRIMARY KEY(session_id,user_id));
CREATE TABLE cash_ledger_entries(
 id serial PRIMARY KEY, tenant_id integer NOT NULL REFERENCES tenants(id), order_id integer NOT NULL REFERENCES orders(id), shift_id integer REFERENCES lab_tech_shifts(id) ON DELETE SET NULL,
 csr_user_id integer NOT NULL REFERENCES users(id), actor_user_id integer NOT NULL REFERENCES users(id), general_queue_session_id integer REFERENCES general_queue_cash_sessions(id), location_id integer REFERENCES inventory_locations(id),
 box_assignment_id text NOT NULL, amount numeric(10,2) NOT NULL, amount_tendered numeric(10,2) NOT NULL, change_given numeric(10,2) NOT NULL, entry_type text NOT NULL DEFAULT 'cash_sale_closeout', idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT cash_ledger_accountability_context_check CHECK(((shift_id IS NOT NULL)::int + (general_queue_session_id IS NOT NULL)::int)=1)
);
`;

function guardedAdminUrl(): URL {
  const raw = process.env.MIGRATION_0039_ADMIN_URL;
  if (!raw) throw new Error("MIGRATION_0039_ADMIN_URL is required");
  const url = new URL(raw);
  const port = Number(url.port);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !Number.isInteger(port) || port < 55000 || port > 55999 || url.pathname !== "/postgres" || /prod|production|myorder_dev|myorder_clone/i.test(url.pathname)) {
    throw new Error("Migration 0039 tests require a disposable loopback PostgreSQL database on port 55000-55999");
  }
  return url;
}

migrationDescribe("migration 0039 General Queue cash reconciliation", () => {
  const suffix = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const goodName = `myorder_migration_0039_good_${suffix}`;
  const badName = `myorder_migration_0039_bad_${suffix}`;
  let admin: pg.Client; let good: pg.Client; let bad: pg.Client;

  beforeAll(async () => {
    const url = guardedAdminUrl(); admin = new Client({ connectionString: url.toString(), ssl: false }); await admin.connect();
    for (const name of [goodName, badName]) await admin.query(`CREATE DATABASE "${name}"`);
    const connect = async (name: string) => { const u = new URL(url); u.pathname = `/${name}`; const c = new Client({ connectionString: u.toString(), ssl: false }); await c.connect(); await c.query(original0038State); return c; };
    good = await connect(goodName); bad = await connect(badName);
    await good.query("INSERT INTO tenants DEFAULT VALUES; INSERT INTO users(tenant_id) VALUES(1); INSERT INTO csr_boxes(tenant_id) VALUES(1); INSERT INTO inventory_locations(tenant_id,csr_box_id) VALUES(1,1); INSERT INTO admin_settings(tenant_id) VALUES(1); INSERT INTO general_queue_cash_sessions(tenant_id,location_id,register_box_id,opened_by_user_id) VALUES(1,1,1,1); INSERT INTO general_queue_cash_session_participants(session_id,user_id,joined_by_user_id) VALUES(1,1,1)");
    await bad.query("ALTER TABLE general_queue_cash_session_participants DROP CONSTRAINT general_queue_cash_session_participants_session_id_fkey; INSERT INTO tenants DEFAULT VALUES; INSERT INTO users(tenant_id) VALUES(1); INSERT INTO general_queue_cash_session_participants(session_id,user_id,joined_by_user_id) VALUES(999,1,1)");
  });

  afterAll(async () => {
    await good?.end().catch(() => undefined); await bad?.end().catch(() => undefined);
    if (admin) { for (const name of [goodName,badName]) { await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",[name]).catch(() => undefined); await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(() => undefined); } await admin.end(); }
  });

  it("does not modify frozen migration 0038", () => {
    expect(createHash("sha256").update(readFileSync(migration0038Path)).digest("hex")).toBe(frozen0038Hash);
  });

  it("backfills ownership and enforces tenant/location integrity", async () => {
    await good.query(migrationSql); await good.query(migrationSql);
    expect((await good.query("SELECT tenant_id FROM general_queue_cash_session_participants WHERE session_id=1")).rows[0].tenant_id).toBe(1);
    expect((await good.query("SELECT is_nullable FROM information_schema.columns WHERE table_name='general_queue_cash_session_participants' AND column_name='tenant_id'")).rows[0].is_nullable).toBe("NO");
    await good.query("INSERT INTO tenants DEFAULT VALUES; INSERT INTO users(tenant_id) VALUES(2); INSERT INTO csr_boxes(tenant_id) VALUES(2); INSERT INTO inventory_locations(tenant_id,csr_box_id) VALUES(2,2)");
    await expect(good.query("INSERT INTO general_queue_cash_session_participants(tenant_id,session_id,user_id,joined_by_user_id) VALUES(2,1,2,2)")).rejects.toMatchObject({ constraint: "gq_participants_tenant_session_fk" });
    await expect(good.query("INSERT INTO general_queue_cash_sessions(tenant_id,location_id,register_box_id,opened_by_user_id,open_idempotency_key) VALUES(1,1,NULL,1,'other')")).rejects.toMatchObject({ constraint: "general_queue_cash_sessions_open_location_uq" });
    await good.query("UPDATE general_queue_cash_sessions SET status='closed' WHERE id=1; INSERT INTO general_queue_cash_sessions(tenant_id,location_id,register_box_id,opened_by_user_id,open_idempotency_key) VALUES(1,1,NULL,1,'no-box')");
  });

  it("fails clearly instead of assigning orphaned participant ownership", async () => {
    await expect(bad.query(migrationSql)).rejects.toThrow(/orphaned or conflicting rows exist/);
  });
});
