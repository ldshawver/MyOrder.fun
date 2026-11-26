import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg, { type PoolClient } from "pg";

const databaseUrl = process.env.DATABASE_URL;

type Fixture = {
  tenantA: number;
  tenantB: number;
  customerA: number;
  catalogItemA: number;
};

async function createFixture(client: PoolClient, suffix: string): Promise<Fixture> {
  const tenantA = (await client.query<{ id: number }>(
    "INSERT INTO tenants (name,slug,status) VALUES ($1,$2,'active') RETURNING id",
    ["Fulfillment group integration A", `fulfillment-group-a-${suffix}`],
  )).rows[0].id;
  const tenantB = (await client.query<{ id: number }>(
    "INSERT INTO tenants (name,slug,status) VALUES ($1,$2,'active') RETURNING id",
    ["Fulfillment group integration B", `fulfillment-group-b-${suffix}`],
  )).rows[0].id;
  const customerA = (await client.query<{ id: number }>(
    "INSERT INTO users (clerk_id,tenant_id,role,status) VALUES ($1,$2,'user','active') RETURNING id",
    [`fulfillment-group-customer-${suffix}`, tenantA],
  )).rows[0].id;
  const catalogItemA = (await client.query<{ id: number }>(
    `INSERT INTO catalog_items (tenant_id,name,category,price,merchant_brand)
     VALUES ($1,'Atomic item','integration','10.00','alavont') RETURNING id`,
    [tenantA],
  )).rows[0].id;
  return { tenantA, tenantB, customerA, catalogItemA };
}

async function insertOrder(client: PoolClient, fixture: Fixture): Promise<number> {
  return (await client.query<{ id: number }>(
    `INSERT INTO orders (tenant_id,customer_id,subtotal,tax,total,payment_method)
     VALUES ($1,$2,'20.00','1.50','21.50','card') RETURNING id`,
    [fixture.tenantA, fixture.customerA],
  )).rows[0].id;
}

async function insertGroup(client: PoolClient, fixture: Fixture, orderId: number, groupKey: string, tenantId = fixture.tenantA): Promise<number> {
  return (await client.query<{ id: number }>(
    `INSERT INTO order_fulfillment_groups
      (tenant_id,order_id,group_key,provider,inventory_owner_snapshot,fulfillment_origin_snapshot,
       method,destination_snapshot,merchandise_subtotal,fee,tax,total,currency,tax_snapshot)
     VALUES ($1,$2,$3,'alavont','alavont','{"locationId":1}'::jsonb,
       'pickup','{"type":"pickup","locationId":1}'::jsonb,'10.00','0.00','0.75','10.75','usd','{"rate":0.075}'::jsonb)
     RETURNING id`,
    [tenantId, orderId, groupKey],
  )).rows[0].id;
}

test("mixed fulfillment groups enforce atomicity and tenant/order line binding", { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const suffix = randomUUID();
  let fixture: Fixture | undefined;

  try {
    const version = await pool.query<{ server_version: string }>("SHOW server_version");
    assert.match(version.rows[0]?.server_version ?? "", /^17\./, "integration target must be PostgreSQL 17");

    const setup = await pool.connect();
    try {
      fixture = await createFixture(setup, suffix);
      const orderA = await insertOrder(setup, fixture);
      const orderB = await insertOrder(setup, fixture);
      const groupA = await insertGroup(setup, fixture, orderA, "alavont:pickup");

      await assert.rejects(
        insertGroup(setup, fixture, orderA, "cross-tenant", fixture.tenantB),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "23503",
        "a group cannot cross the parent order tenant boundary",
      );

      await assert.rejects(
        setup.query(
          `INSERT INTO order_items
            (order_id,fulfillment_group_id,catalog_item_id,catalog_item_name,quantity,unit_price,total_price)
           VALUES ($1,$2,$3,'Wrong parent line',1,'10.00','10.00')`,
          [orderB, groupA, fixture.catalogItemA],
        ),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "23503",
        "a line cannot bind to a group from another parent order",
      );

      await setup.query("BEGIN");
      const rolledBackOrder = await insertOrder(setup, fixture);
      const rolledBackGroup = await insertGroup(setup, fixture, rolledBackOrder, "rollback:pickup");
      await setup.query(
        `INSERT INTO order_items
          (order_id,fulfillment_group_id,catalog_item_id,catalog_item_name,quantity,unit_price,total_price)
         VALUES ($1,$2,$3,'Rollback line',1,'10.00','10.00')`,
        [rolledBackOrder, rolledBackGroup, fixture.catalogItemA],
      );
      await setup.query("ROLLBACK");
      assert.equal((await setup.query("SELECT id FROM orders WHERE id=$1", [rolledBackOrder])).rowCount, 0);
      assert.equal((await setup.query("SELECT id FROM order_fulfillment_groups WHERE order_id=$1", [rolledBackOrder])).rowCount, 0);
      assert.equal((await setup.query("SELECT id FROM order_items WHERE order_id=$1", [rolledBackOrder])).rowCount, 0);

      await setup.query("BEGIN");
      const mixedOrder = await insertOrder(setup, fixture);
      const pickupGroup = await insertGroup(setup, fixture, mixedOrder, "alavont:pickup");
      const shippingGroup = (await setup.query<{ id: number }>(
        `INSERT INTO order_fulfillment_groups
          (tenant_id,order_id,group_key,provider,inventory_owner_snapshot,fulfillment_origin_snapshot,
           method,destination_snapshot,merchandise_subtotal,fee,tax,total,currency,tax_snapshot)
         VALUES ($1,$2,'cj:standard','cj','cj','{"supplier":"cj"}'::jsonb,
           'standard_shipping','{"type":"customer_address","postalCode":"98101"}'::jsonb,
           '10.00','0.00','0.75','10.75','usd','{"rate":0.075}'::jsonb) RETURNING id`,
        [fixture.tenantA, mixedOrder],
      )).rows[0].id;
      await setup.query(
        `INSERT INTO order_items
          (order_id,fulfillment_group_id,catalog_item_id,catalog_item_name,quantity,unit_price,total_price)
         VALUES ($1,$2,$4,'Pickup line',1,'10.00','10.00'),($1,$3,$4,'Shipping line',1,'10.00','10.00')`,
        [mixedOrder, pickupGroup, shippingGroup, fixture.catalogItemA],
      );
      await setup.query("COMMIT");

      const persisted = await setup.query<{ groups: number; lines: number; bound_lines: number }>(
        `SELECT count(DISTINCT fg.id)::int AS groups, count(DISTINCT oi.id)::int AS lines,
                count(DISTINCT oi.id) FILTER (WHERE oi.fulfillment_group_id IS NOT NULL)::int AS bound_lines
         FROM order_fulfillment_groups fg
         LEFT JOIN order_items oi ON oi.order_id=fg.order_id AND oi.fulfillment_group_id=fg.id
         WHERE fg.tenant_id=$1 AND fg.order_id=$2`,
        [fixture.tenantA, mixedOrder],
      );
      assert.deepEqual(persisted.rows[0], { groups: 2, lines: 2, bound_lines: 2 });
    } finally {
      setup.release();
    }
  } finally {
    if (fixture) {
      await pool.query(
        "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id=$1)",
        [fixture.tenantA],
      ).catch(() => undefined);
      await pool.query("DELETE FROM order_fulfillment_groups WHERE tenant_id=$1", [fixture.tenantA]).catch(() => undefined);
      await pool.query("DELETE FROM orders WHERE tenant_id=$1", [fixture.tenantA]).catch(() => undefined);
      await pool.query("DELETE FROM catalog_items WHERE id=$1", [fixture.catalogItemA]).catch(() => undefined);
      await pool.query("DELETE FROM users WHERE id=$1", [fixture.customerA]).catch(() => undefined);
      await pool.query("DELETE FROM tenants WHERE id = ANY($1::int[])", [[fixture.tenantA, fixture.tenantB]]).catch(() => undefined);
    }
    await pool.end();
  }
});
