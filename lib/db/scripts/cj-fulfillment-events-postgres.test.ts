import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;

test("CJ fulfillment events enforce isolation, replay safety, locking, and atomic reconciliation", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const suffix = randomUUID();
  const payloadHash = createHash("sha256").update(`cj-event-${suffix}`).digest("hex");
  let tenantA: number | undefined;
  let tenantB: number | undefined;
  let customerA: number | undefined;
  let orderId: number | undefined;
  let groupId: number | undefined;
  let fulfillmentId: number | undefined;

  try {
    const version = await pool.query<{ server_version: string }>("SHOW server_version");
    assert.match(version.rows[0]?.server_version ?? "", /^17\./, "integration target must be PostgreSQL 17");

    tenantA = (await pool.query<{ id: number }>(
      "INSERT INTO tenants (name,slug,status) VALUES ($1,$2,'active') RETURNING id",
      ["CJ event integration A", `cj-event-a-${suffix}`],
    )).rows[0].id;
    tenantB = (await pool.query<{ id: number }>(
      "INSERT INTO tenants (name,slug,status) VALUES ($1,$2,'active') RETURNING id",
      ["CJ event integration B", `cj-event-b-${suffix}`],
    )).rows[0].id;
    customerA = (await pool.query<{ id: number }>(
      "INSERT INTO users (clerk_id,tenant_id,role,status) VALUES ($1,$2,'user','active') RETURNING id",
      [`cj-event-customer-${suffix}`, tenantA],
    )).rows[0].id;
    orderId = (await pool.query<{ id: number }>(
      `INSERT INTO orders (tenant_id,customer_id,subtotal,tax,total,payment_method,fulfillment_status)
       VALUES ($1,$2,'10.00','0.75','10.75','card','pending') RETURNING id`,
      [tenantA, customerA],
    )).rows[0].id;
    groupId = (await pool.query<{ id: number }>(
      `INSERT INTO order_fulfillment_groups
        (tenant_id,order_id,group_key,provider,inventory_owner_snapshot,fulfillment_origin_snapshot,
         method,destination_snapshot,merchandise_subtotal,fee,tax,total,currency,tax_snapshot,status)
       VALUES ($1,$2,'cj:standard','cj','cj','{"supplier":"cj"}'::jsonb,
         'standard_shipping','{"type":"customer_address","postalCode":"98101"}'::jsonb,
         '10.00','0.00','0.75','10.75','usd','{"rate":0.075}'::jsonb,'pending') RETURNING id`,
      [tenantA, orderId],
    )).rows[0].id;
    fulfillmentId = (await pool.query<{ id: number }>(
      `INSERT INTO cj_order_fulfillments (tenant_id,order_id,fulfillment_group_id,provider_order_id)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenantA, orderId, groupId, `provider-order-${suffix}`],
    )).rows[0].id;

    await assert.rejects(
      pool.query(
        `INSERT INTO cj_fulfillment_events
          (tenant_id,fulfillment_id,provider_event_id,event_type,provider_order_id,provider_status,payload_sha256)
         VALUES ($1,$2,$3,'order.updated',$4,'processing',$5)`,
        [tenantB, fulfillmentId, `cross-tenant-${suffix}`, `provider-order-${suffix}`, payloadHash],
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "23503",
      "an event cannot cross the fulfillment tenant boundary",
    );

    const rollbackClient = await pool.connect();
    try {
      await rollbackClient.query("BEGIN");
      await rollbackClient.query(
        `INSERT INTO cj_fulfillment_events
          (tenant_id,fulfillment_id,provider_event_id,event_type,provider_order_id,provider_status,payload_sha256)
         VALUES ($1,$2,$3,'order.updated',$4,'on_hold',$5)`,
        [tenantA, fulfillmentId, `rollback-${suffix}`, `provider-order-${suffix}`, payloadHash],
      );
      await rollbackClient.query(
        "UPDATE cj_order_fulfillments SET reconciliation_state='reconciliation_required' WHERE id=$1",
        [fulfillmentId],
      );
      await rollbackClient.query("UPDATE order_fulfillment_groups SET status='reconciliation_required' WHERE id=$1", [groupId]);
      await rollbackClient.query("UPDATE orders SET fulfillment_status='reconciliation_required' WHERE id=$1", [orderId]);
      await rollbackClient.query("ROLLBACK");
    } finally {
      rollbackClient.release();
    }
    assert.equal((await pool.query("SELECT id FROM cj_fulfillment_events WHERE provider_event_id=$1", [`rollback-${suffix}`])).rowCount, 0);
    assert.equal((await pool.query<{ reconciliation_state: string }>(
      "SELECT reconciliation_state FROM cj_order_fulfillments WHERE id=$1", [fulfillmentId],
    )).rows[0].reconciliation_state, "pending");

    const lockOwner = await pool.connect();
    const lockWaiter = await pool.connect();
    try {
      await lockOwner.query("BEGIN");
      await lockOwner.query("SELECT id FROM cj_order_fulfillments WHERE id=$1 FOR UPDATE", [fulfillmentId]);
      await lockWaiter.query("BEGIN");
      await lockWaiter.query("SET LOCAL lock_timeout='150ms'");
      await assert.rejects(
        lockWaiter.query("UPDATE cj_order_fulfillments SET provider_status='processing' WHERE id=$1", [fulfillmentId]),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "55P03",
      );
      await lockWaiter.query("ROLLBACK");
      await lockOwner.query("ROLLBACK");
    } finally {
      lockOwner.release();
      lockWaiter.release();
    }

    const replayInsert = `INSERT INTO cj_fulfillment_events
      (tenant_id,fulfillment_id,provider_event_id,event_type,provider_order_id,provider_status,payload_sha256)
      VALUES ($1,$2,$3,'order.updated',$4,'processing',$5)
      ON CONFLICT DO NOTHING RETURNING id`;
    const replayId = `replay-${suffix}`;
    const replayResults = await Promise.all([
      pool.query(replayInsert, [tenantA, fulfillmentId, replayId, `provider-order-${suffix}`, payloadHash]),
      pool.query(replayInsert, [tenantA, fulfillmentId, replayId, `provider-order-${suffix}`, payloadHash]),
    ]);
    assert.deepEqual(replayResults.map((result) => result.rowCount).sort(), [0, 1], "concurrent replay claims exactly once");

    const reconciliationEventId = `reconcile-${suffix}`;
    const reconciliation = await pool.connect();
    try {
      await reconciliation.query("BEGIN");
      const eventId = (await reconciliation.query<{ id: number }>(
        `INSERT INTO cj_fulfillment_events
          (tenant_id,fulfillment_id,provider_event_id,event_type,provider_order_id,provider_status,payload_sha256)
         VALUES ($1,$2,$3,'order.updated',$4,'on_hold',$5) RETURNING id`,
        [tenantA, fulfillmentId, reconciliationEventId, `provider-order-${suffix}`, payloadHash],
      )).rows[0].id;
      await reconciliation.query(
        `UPDATE cj_order_fulfillments SET provider_status='on_hold',reconciliation_state='reconciliation_required',updated_at=now()
         WHERE tenant_id=$1 AND id=$2`, [tenantA, fulfillmentId],
      );
      await reconciliation.query(
        "UPDATE order_fulfillment_groups SET status='reconciliation_required',updated_at=now() WHERE tenant_id=$1 AND order_id=$2 AND id=$3 AND provider='cj'",
        [tenantA, orderId, groupId],
      );
      await reconciliation.query(
        "UPDATE orders SET fulfillment_status='reconciliation_required',updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenantA, orderId],
      );
      await reconciliation.query("UPDATE cj_fulfillment_events SET processed_at=now() WHERE tenant_id=$1 AND id=$2", [tenantA, eventId]);
      await reconciliation.query("COMMIT");
    } finally {
      reconciliation.release();
    }

    const persisted = await pool.query<{
      provider_status: string;
      reconciliation_state: string;
      group_status: string;
      parent_status: string;
      processed: boolean;
    }>(
      `SELECT cf.provider_status,cf.reconciliation_state,fg.status AS group_status,
              o.fulfillment_status AS parent_status,(ce.processed_at IS NOT NULL) AS processed
       FROM cj_order_fulfillments cf
       JOIN order_fulfillment_groups fg ON fg.id=cf.fulfillment_group_id AND fg.order_id=cf.order_id
       JOIN orders o ON o.id=cf.order_id AND o.tenant_id=cf.tenant_id
       JOIN cj_fulfillment_events ce ON ce.fulfillment_id=cf.id AND ce.tenant_id=cf.tenant_id
       WHERE cf.tenant_id=$1 AND cf.id=$2 AND ce.provider_event_id=$3`,
      [tenantA, fulfillmentId, reconciliationEventId],
    );
    assert.deepEqual(persisted.rows[0], {
      provider_status: "on_hold",
      reconciliation_state: "reconciliation_required",
      group_status: "reconciliation_required",
      parent_status: "reconciliation_required",
      processed: true,
    });
  } finally {
    if (tenantA) {
      await pool.query("DELETE FROM cj_fulfillment_events WHERE tenant_id=$1", [tenantA]).catch(() => undefined);
      await pool.query("DELETE FROM cj_order_fulfillments WHERE tenant_id=$1", [tenantA]).catch(() => undefined);
      await pool.query("DELETE FROM order_fulfillment_groups WHERE tenant_id=$1", [tenantA]).catch(() => undefined);
      await pool.query("DELETE FROM orders WHERE tenant_id=$1", [tenantA]).catch(() => undefined);
    }
    if (customerA) await pool.query("DELETE FROM users WHERE id=$1", [customerA]).catch(() => undefined);
    if (tenantA || tenantB) {
      await pool.query("DELETE FROM tenants WHERE id = ANY($1::int[])", [[tenantA, tenantB].filter(Boolean)]).catch(() => undefined);
    }
    await pool.end();
  }
});
