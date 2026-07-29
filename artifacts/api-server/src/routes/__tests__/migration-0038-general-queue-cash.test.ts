import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Client } = pg;
const enabled = process.env.RUN_MIGRATION_0038_E2E === "1";
const migrationDescribe = enabled ? describe : describe.skip;
const repoRoot = resolve(import.meta.dirname, "../../../../..");
const migrationSql = readFileSync(
  resolve(repoRoot, "lib/db/drizzle/0038_general_queue_cash_sessions.sql"),
  "utf8",
);

const baselineSql = `
  CREATE TABLE tenants (id serial PRIMARY KEY);
  CREATE TABLE users (
    id serial PRIMARY KEY,
    tenant_id integer REFERENCES tenants(id)
  );
  CREATE TABLE csr_boxes (
    id serial PRIMARY KEY,
    tenant_id integer NOT NULL REFERENCES tenants(id)
  );
  CREATE TABLE inventory_locations (
    id serial PRIMARY KEY,
    tenant_id integer NOT NULL REFERENCES tenants(id)
  );
  CREATE TABLE orders (
    id serial PRIMARY KEY,
    tenant_id integer NOT NULL REFERENCES tenants(id)
  );
  CREATE TABLE lab_tech_shifts (
    id serial PRIMARY KEY,
    tenant_id integer NOT NULL REFERENCES tenants(id)
  );
  CREATE TABLE cash_ledger_entries (
    id serial PRIMARY KEY,
    tenant_id integer NOT NULL REFERENCES tenants(id),
    order_id integer NOT NULL REFERENCES orders(id),
    shift_id integer REFERENCES lab_tech_shifts(id) ON DELETE SET NULL,
    csr_user_id integer NOT NULL REFERENCES users(id),
    box_assignment_id text NOT NULL,
    amount numeric(10,2) NOT NULL,
    entry_type text NOT NULL DEFAULT 'cash_sale_closeout',
    idempotency_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

function guardedAdminUrl(): URL {
  const raw = process.env.MIGRATION_0038_ADMIN_URL;
  if (!raw) throw new Error("MIGRATION_0038_ADMIN_URL is required");
  const url = new URL(raw);
  const port = Number(url.port);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Migration 0038 tests require a loopback PostgreSQL host");
  }
  if (!Number.isInteger(port) || port < 55000 || port > 55999) {
    throw new Error("Migration 0038 tests require an isolated port in 55000-55999");
  }
  if (url.pathname !== "/postgres") {
    throw new Error("Migration 0038 admin URL must target the disposable postgres database");
  }
  if (/prod|production|myorder_dev|myorder_clone/i.test(url.pathname)) {
    throw new Error("Refusing a development or production database");
  }
  return url;
}

function databaseUrl(adminUrl: URL, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function expectConstraintFailure(
  client: pg.Client,
  statement: string,
  constraint: string,
): Promise<void> {
  await expect(client.query(statement)).rejects.toMatchObject({
    constraint,
  });
}

migrationDescribe("migration 0038 General Queue cash accountability", () => {
  const suffix = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const cleanDb = `myorder_migration_0038_clean_${suffix}`;
  const upgradeDb = `myorder_migration_0038_upgrade_${suffix}`;
  let admin: pg.Client;
  let clean: pg.Client;
  let upgrade: pg.Client;

  beforeAll(async () => {
    const adminUrl = guardedAdminUrl();
    admin = new Client({ connectionString: adminUrl.toString(), ssl: false });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${cleanDb}"`);
    await admin.query(`CREATE DATABASE "${upgradeDb}"`);

    clean = new Client({ connectionString: databaseUrl(adminUrl, cleanDb), ssl: false });
    upgrade = new Client({ connectionString: databaseUrl(adminUrl, upgradeDb), ssl: false });
    await clean.connect();
    await upgrade.connect();
    await clean.query(baselineSql);
    await upgrade.query(baselineSql);

    await upgrade.query(`
      INSERT INTO tenants DEFAULT VALUES;
      INSERT INTO users(tenant_id) VALUES (1);
      INSERT INTO csr_boxes(tenant_id) VALUES (1);
      INSERT INTO inventory_locations(tenant_id) VALUES (1);
      INSERT INTO orders(tenant_id) VALUES (1);
      INSERT INTO lab_tech_shifts(tenant_id) VALUES (1);
      INSERT INTO cash_ledger_entries(
        tenant_id, order_id, shift_id, csr_user_id, box_assignment_id,
        amount, idempotency_key
      ) VALUES (1, 1, 1, 1, 'sales-box-1', 21.60, 'legacy-ledger');
      CREATE TABLE general_queue_cash_sessions (
        id serial PRIMARY KEY,
        tenant_id integer NOT NULL REFERENCES tenants(id),
        location_id integer NOT NULL REFERENCES inventory_locations(id),
        register_box_id integer NOT NULL REFERENCES csr_boxes(id),
        status text NOT NULL DEFAULT 'open',
        opened_by_user_id integer NOT NULL REFERENCES users(id),
        opened_at timestamptz NOT NULL DEFAULT now(),
        opening_balance numeric(10,2) NOT NULL DEFAULT 0,
        closed_by_user_id integer REFERENCES users(id),
        closed_at timestamptz,
        closing_balance numeric(10,2),
        expected_balance numeric(10,2),
        difference_amount numeric(10,2),
        payment_totals_json json DEFAULT '{}'::json,
        summary json DEFAULT '{}'::json,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE general_queue_cash_session_participants (
        session_id integer NOT NULL REFERENCES general_queue_cash_sessions(id),
        user_id integer NOT NULL REFERENCES users(id),
        joined_at timestamptz NOT NULL DEFAULT now(),
        joined_by_user_id integer NOT NULL REFERENCES users(id),
        left_at timestamptz,
        PRIMARY KEY (session_id, user_id)
      );
      INSERT INTO general_queue_cash_sessions(
        tenant_id, location_id, register_box_id, opened_by_user_id
      ) VALUES (1, 1, 1, 1);
      INSERT INTO general_queue_cash_session_participants(
        session_id, user_id, joined_by_user_id
      ) VALUES (1, 1, 1);
    `);
  });

  afterAll(async () => {
    await clean?.end().catch(() => undefined);
    await upgrade?.end().catch(() => undefined);
    if (admin) {
      for (const database of [cleanDb, upgradeDb]) {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [database],
        ).catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
    }
  });

  it("applies to an empty pre-0038 prerequisite schema and is repeatable", async () => {
    await clean.query(migrationSql);
    await clean.query(migrationSql);
    const result = await clean.query(
      "SELECT to_regclass('general_queue_cash_sessions')::text AS sessions, to_regclass('general_queue_cash_session_participants')::text AS participants",
    );
    expect(result.rows[0]).toEqual({
      sessions: "general_queue_cash_sessions",
      participants: "general_queue_cash_session_participants",
    });
  });

  it("backfills legacy ledger and participant ownership deterministically", async () => {
    await upgrade.query(migrationSql);
    const ledger = await upgrade.query(`
      SELECT actor_user_id = csr_user_id AS actor_ok,
             amount_tendered = amount AS tender_ok,
             change_given = 0 AS change_ok,
             shift_id = 1 AS shift_ok,
             general_queue_session_id IS NULL AS session_null
      FROM cash_ledger_entries WHERE id = 1
    `);
    expect(ledger.rows[0]).toEqual({
      actor_ok: true,
      tender_ok: true,
      change_ok: true,
      shift_ok: true,
      session_null: true,
    });
    const participant = await upgrade.query(
      "SELECT tenant_id, session_id, user_id FROM general_queue_cash_session_participants WHERE session_id = 1 AND user_id = 1",
    );
    expect(participant.rows[0]).toEqual({ tenant_id: 1, session_id: 1, user_id: 1 });
  });

  it("enforces status, accountability contexts, tenant ownership, and nullable relationships", async () => {
    await clean.query(`
      INSERT INTO tenants DEFAULT VALUES;
      INSERT INTO tenants DEFAULT VALUES;
      INSERT INTO users(tenant_id) VALUES (1), (2), (NULL), (1);
      INSERT INTO csr_boxes(tenant_id) VALUES (1), (2);
      INSERT INTO inventory_locations(tenant_id) VALUES (1), (2);
      INSERT INTO orders(tenant_id) VALUES (1), (1), (1), (1), (1), (1);
      INSERT INTO lab_tech_shifts(tenant_id) VALUES (1);
    `);

    await expectConstraintFailure(
      clean,
      "INSERT INTO general_queue_cash_sessions(tenant_id,location_id,register_box_id,status,opened_by_user_id) VALUES (1,1,1,'invalid',1)",
      "general_queue_cash_sessions_status_check",
    );
    await expectConstraintFailure(
      clean,
      "INSERT INTO general_queue_cash_sessions(tenant_id,location_id,register_box_id,opened_by_user_id) VALUES (1,2,1,1)",
      "gq_sessions_tenant_location_fk",
    );
    await expectConstraintFailure(
      clean,
      "INSERT INTO general_queue_cash_sessions(tenant_id,location_id,register_box_id,opened_by_user_id) VALUES (1,1,2,1)",
      "gq_sessions_tenant_register_box_fk",
    );
    await expectConstraintFailure(
      clean,
      "INSERT INTO general_queue_cash_sessions(tenant_id,location_id,register_box_id,opened_by_user_id) VALUES (1,1,1,2)",
      "gq_sessions_tenant_opened_by_user_fk",
    );
    await expectConstraintFailure(
      clean,
      "INSERT INTO general_queue_cash_sessions(tenant_id,location_id,register_box_id,opened_by_user_id) VALUES (1,1,1,3)",
      "gq_sessions_tenant_opened_by_user_fk",
    );
    await expectConstraintFailure(
      clean,
      "INSERT INTO general_queue_cash_sessions(tenant_id,location_id,register_box_id,status,opened_by_user_id,closed_by_user_id) VALUES (1,1,1,'closed',1,2)",
      "gq_sessions_tenant_closed_by_user_fk",
    );

    await clean.query(
      "SELECT setval(pg_get_serial_sequence('general_queue_cash_sessions', 'id'), 1, false)",
    );
    await clean.query(
      "INSERT INTO general_queue_cash_sessions(tenant_id,location_id,register_box_id,opened_by_user_id,closed_by_user_id) VALUES (1,1,1,1,NULL)",
    );
    await clean.query(
      "INSERT INTO general_queue_cash_session_participants(tenant_id,session_id,user_id,joined_by_user_id) VALUES (1,1,1,1)",
    );
    await expectConstraintFailure(
      clean,
      "INSERT INTO general_queue_cash_session_participants(tenant_id,session_id,user_id,joined_by_user_id) VALUES (2,1,2,2)",
      "gq_participants_tenant_session_fk",
    );
    await expectConstraintFailure(
      clean,
      "INSERT INTO general_queue_cash_session_participants(tenant_id,session_id,user_id,joined_by_user_id) VALUES (1,1,2,1)",
      "gq_participants_tenant_user_fk",
    );
    await expectConstraintFailure(
      clean,
      "INSERT INTO general_queue_cash_session_participants(tenant_id,session_id,user_id,joined_by_user_id) VALUES (1,1,3,1)",
      "gq_participants_tenant_user_fk",
    );
    await expectConstraintFailure(
      clean,
      "INSERT INTO general_queue_cash_session_participants(tenant_id,session_id,user_id,joined_by_user_id) VALUES (1,1,4,2)",
      "gq_participants_tenant_joined_by_user_fk",
    );

    const ledgerBase = `
      tenant_id,order_id,csr_user_id,actor_user_id,box_assignment_id,
      amount,amount_tendered,change_given,idempotency_key
    `;
    await expectConstraintFailure(
      clean,
      `INSERT INTO cash_ledger_entries(${ledgerBase}) VALUES (1,1,1,1,'box',10,10,0,'zero-context')`,
      "cash_ledger_accountability_context_check",
    );
    await expectConstraintFailure(
      clean,
      `INSERT INTO cash_ledger_entries(${ledgerBase},shift_id,general_queue_session_id) VALUES (1,2,1,1,'box',10,10,0,'two-contexts',1,1)`,
      "cash_ledger_accountability_context_check",
    );
    await clean.query(
      `INSERT INTO cash_ledger_entries(${ledgerBase},shift_id,location_id) VALUES (1,3,1,1,'box',10,10,0,'shift-context',1,NULL)`,
    );
    await clean.query(
      `INSERT INTO cash_ledger_entries(${ledgerBase},general_queue_session_id,location_id) VALUES (1,4,1,1,'box',10,10,0,'session-context',1,NULL)`,
    );
    await expectConstraintFailure(
      clean,
      `INSERT INTO cash_ledger_entries(${ledgerBase},general_queue_session_id) VALUES (2,5,2,2,'box',10,10,0,'cross-session',1)`,
      "cash_ledger_tenant_gq_session_fk",
    );
    await expectConstraintFailure(
      clean,
      `INSERT INTO cash_ledger_entries(${ledgerBase},shift_id) VALUES (1,5,1,2,'box',10,10,0,'cross-actor',1)`,
      "cash_ledger_tenant_actor_user_fk",
    );
    await expectConstraintFailure(
      clean,
      `INSERT INTO cash_ledger_entries(${ledgerBase},shift_id) VALUES (1,5,1,3,'box',10,10,0,'null-actor-tenant',1)`,
      "cash_ledger_tenant_actor_user_fk",
    );
    await expectConstraintFailure(
      clean,
      `INSERT INTO cash_ledger_entries(${ledgerBase},shift_id,location_id) VALUES (1,6,1,1,'box',10,10,0,'cross-location',1,2)`,
      "cash_ledger_tenant_location_fk",
    );
  });

  it("keeps migration and Drizzle constraint names in parity", () => {
    const sources = [
      readFileSync(resolve(repoRoot, "lib/db/src/schema/users.ts"), "utf8"),
      readFileSync(resolve(repoRoot, "lib/db/src/schema/shifts.ts"), "utf8"),
      readFileSync(resolve(repoRoot, "lib/db/src/schema/orders.ts"), "utf8"),
    ].join("\n");
    const names = [
      "users_tenant_id_id_unique",
      "inventory_locations_tenant_id_id_unique",
      "csr_boxes_tenant_id_id_unique",
      "general_queue_cash_sessions_tenant_id_id_unique",
      "general_queue_cash_sessions_status_check",
      "cash_ledger_accountability_context_check",
      "gq_sessions_tenant_location_fk",
      "gq_sessions_tenant_register_box_fk",
      "gq_sessions_tenant_opened_by_user_fk",
      "gq_sessions_tenant_closed_by_user_fk",
      "gq_participants_tenant_session_fk",
      "gq_participants_tenant_user_fk",
      "gq_participants_tenant_joined_by_user_fk",
      "cash_ledger_tenant_gq_session_fk",
      "cash_ledger_tenant_actor_user_fk",
      "cash_ledger_tenant_location_fk",
    ];
    for (const name of names) {
      expect(migrationSql).toContain(`"${name}"`);
      expect(sources).toContain(`"${name}"`);
    }
  });
});
