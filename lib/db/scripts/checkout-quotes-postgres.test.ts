import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;

test("durable checkout quotes enforce scope, expiry, rollback, locking, and single consumption", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const suffix = randomUUID();
  const quoteIds = {
    active: `checkout-pg-active-${suffix}`,
    expired: `checkout-pg-expired-${suffix}`,
    locked: `checkout-pg-locked-${suffix}`,
  };
  let tenantA: number | undefined;
  let tenantB: number | undefined;
  let customerA: number | undefined;
  let customerB: number | undefined;

  try {
    const version = await pool.query<{ server_version: string }>("SHOW server_version");
    assert.match(version.rows[0]?.server_version ?? "", /^17\./, "integration target must be PostgreSQL 17");

    tenantA = (await pool.query<{ id: number }>(
      "INSERT INTO tenants (name,slug,status) VALUES ($1,$2,'active') RETURNING id",
      ["Checkout quote integration A", `checkout-pg-a-${suffix}`],
    )).rows[0].id;
    tenantB = (await pool.query<{ id: number }>(
      "INSERT INTO tenants (name,slug,status) VALUES ($1,$2,'active') RETURNING id",
      ["Checkout quote integration B", `checkout-pg-b-${suffix}`],
    )).rows[0].id;
    customerA = (await pool.query<{ id: number }>(
      "INSERT INTO users (clerk_id,tenant_id,role,status) VALUES ($1,$2,'user','active') RETURNING id",
      [`checkout-pg-a-${suffix}`, tenantA],
    )).rows[0].id;
    customerB = (await pool.query<{ id: number }>(
      "INSERT INTO users (clerk_id,tenant_id,role,status) VALUES ($1,$2,'user','active') RETURNING id",
      [`checkout-pg-b-${suffix}`, tenantB],
    )).rows[0].id;

    const insertQuote = `INSERT INTO checkout_quotes
      (id,tenant_id,customer_id,cart_fingerprint,tax_configuration_id,quote_snapshot,status,expires_at)
      VALUES ($1,$2,$3,$4,1,'{}'::jsonb,'quoted',$5)`;
    await pool.query(insertQuote, [quoteIds.active, tenantA, customerA, "active", new Date(Date.now() + 60_000)]);
    await pool.query(insertQuote, [quoteIds.expired, tenantA, customerA, "expired", new Date(Date.now() - 60_000)]);
    await pool.query(insertQuote, [quoteIds.locked, tenantA, customerA, "locked", new Date(Date.now() + 60_000)]);

    const authoritativeLookup = `SELECT id FROM checkout_quotes
      WHERE id=$1 AND tenant_id=$2 AND customer_id=$3 AND status='quoted' AND expires_at>now()`;
    assert.equal((await pool.query(authoritativeLookup, [quoteIds.active, tenantA, customerA])).rowCount, 1);
    assert.equal((await pool.query(authoritativeLookup, [quoteIds.active, tenantB, customerA])).rowCount, 0, "cross-tenant lookup");
    assert.equal((await pool.query(authoritativeLookup, [quoteIds.active, tenantA, customerB])).rowCount, 0, "cross-customer lookup");
    assert.equal((await pool.query(authoritativeLookup, [quoteIds.expired, tenantA, customerA])).rowCount, 0, "expired lookup");

    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query("BEGIN");
      assert.equal((await rollbackClient.query(
        "UPDATE checkout_quotes SET status='consumed',consumed_at=now() WHERE id=$1 AND status='quoted' RETURNING id",
        [quoteIds.active],
      )).rowCount, 1);
      await rollbackClient.query("ROLLBACK");
    } finally {
      rollbackClient.release();
    }
    assert.equal((await pool.query(authoritativeLookup, [quoteIds.active, tenantA, customerA])).rowCount, 1, "rollback restores quote");

    const lockOwner = await pool.connect();
    const lockWaiter = await pool.connect();
    try {
      await lockOwner.query("BEGIN");
      await lockOwner.query("SELECT id FROM checkout_quotes WHERE id=$1 FOR UPDATE", [quoteIds.locked]);
      await lockWaiter.query("BEGIN");
      await lockWaiter.query("SET LOCAL lock_timeout='150ms'");
      await assert.rejects(
        lockWaiter.query("UPDATE checkout_quotes SET status='consumed' WHERE id=$1", [quoteIds.locked]),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "55P03",
      );
      await lockWaiter.query("ROLLBACK");
      await lockOwner.query("ROLLBACK");
    } finally {
      lockOwner.release();
      lockWaiter.release();
    }

    const consumeSql = `UPDATE checkout_quotes SET status='consumed',consumed_at=now()
      WHERE id=$1 AND tenant_id=$2 AND customer_id=$3 AND status='quoted' AND expires_at>now() RETURNING id`;
    const results = await Promise.all([
      pool.query(consumeSql, [quoteIds.active, tenantA, customerA]),
      pool.query(consumeSql, [quoteIds.active, tenantA, customerA]),
    ]);
    assert.deepEqual(results.map((result) => result.rowCount).sort(), [0, 1], "concurrent double consumption");
    assert.equal((await pool.query(consumeSql, [quoteIds.active, tenantA, customerA])).rowCount, 0, "replay is idempotently rejected");
  } finally {
    await pool.query("DELETE FROM checkout_quotes WHERE id = ANY($1::text[])", [Object.values(quoteIds)]).catch(() => undefined);
    if (customerA || customerB) await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [[customerA, customerB].filter(Boolean)]).catch(() => undefined);
    if (tenantA || tenantB) await pool.query("DELETE FROM tenants WHERE id = ANY($1::int[])", [[tenantA, tenantB].filter(Boolean)]).catch(() => undefined);
    await pool.end();
  }
});
