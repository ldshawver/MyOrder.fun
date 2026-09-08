import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrelaunchTestVoidError, voidPrelaunchTestOrder } from "../prelaunchTestOrderRecovery";

const enabled = process.env.RUN_PRELAUNCH_RECOVERY_INTEGRATION === "1";
const suite = enabled ? describe : describe.skip;
const { Client } = pg;
const runId = `prelaunch_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
const key = (name: string) => `prelaunch-test-void-${runId}-${name}`;
const actor = (id: number, role = "admin") => ({ id, role, email: `${runId}@example.test` });

let client: pg.Client;
let tenant = 0; let foreignTenant = 0; let admin = 0; let ordinary = 0; let customer = 0;
let location = 0; let item = 0;

async function makeOrder(opts: { status?: string; reservationStatus?: string; quantity?: number; payment?: boolean } = {}) {
  const order = await client.query(
    `INSERT INTO orders (tenant_id, customer_id, status, payment_status, payment_method, subtotal, tax, total, fulfillment_status)
     VALUES ($1,$2,$3,'unpaid','cash',10,0,10,$3) RETURNING id`,
    [tenant, customer, opts.status ?? "ready"],
  );
  const orderId = Number(order.rows[0].id);
  const itemRow = await client.query(
    `INSERT INTO order_items (order_id,catalog_item_id,catalog_item_name,quantity,unit_price,total_price)
     VALUES ($1,$2,$3,$4,10,$4*10) RETURNING id`,
    [orderId, item, `${runId} item`, opts.quantity ?? 2],
  );
  await client.query(
    `INSERT INTO inventory_reservations (order_id,catalog_item_id,location_id,quantity,status,expires_at)
     VALUES ($1,$2,$3,$4,$5,now()+interval '1 hour')`,
    [orderId, item, location, opts.quantity ?? 2, opts.reservationStatus ?? "confirmed"],
  );
  if (opts.payment) {
    await client.query(
      `INSERT INTO payment_attempts (tenant_id,order_id,provider,provider_environment,idempotency_key,requested_amount,requested_currency,state)
       VALUES ($1,$2,'paypal','sandbox',$3,10,'USD','captured')`, [tenant, orderId, `${runId}-${orderId}`],
    );
  }
  return { orderId, itemId: Number(itemRow.rows[0].id) };
}

const recovery = (orderId: number, idempotencyKey: string, actorValue = actor(admin), tenantId = tenant) =>
  voidPrelaunchTestOrder({ tenantId, orderId, idempotencyKey, actor: actorValue });

suite("pre-launch test-order recovery integration", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/127\.0\.0\.1|localhost/);
    client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await client.connect();
    const tenants = await client.query(
      `INSERT INTO tenants (name,slug,status) VALUES ($1,$2,'active'),($3,$4,'active') RETURNING id,slug`,
      [`${runId} A`, `${runId}-a`, `${runId} B`, `${runId}-b`],
    );
    tenant = Number(tenants.rows.find(row => row.slug === `${runId}-a`).id);
    foreignTenant = Number(tenants.rows.find(row => row.slug === `${runId}-b`).id);
    const users = await client.query(
      `INSERT INTO users (clerk_id,email,normalized_email,role,tenant_id,status,is_active,identity_status,provisioning_status)
       VALUES ($1,$2,$2,'admin',$3,'approved',true,'verified','active'),($4,$5,$5,'user',$3,'approved',true,'verified','active'),($6,$7,$7,'user',$8,'approved',true,'verified','active') RETURNING id,role`,
      [`${runId}-admin`, `${runId}-admin@example.test`, tenant, `${runId}-ordinary`, `${runId}-ordinary@example.test`, `${runId}-customer`, `${runId}-customer@example.test`, foreignTenant],
    );
    admin = Number(users.rows[0].id); ordinary = Number(users.rows[1].id); customer = Number(users.rows[2].id);
    const loc = await client.query(`INSERT INTO inventory_locations (tenant_id,type,name,is_active) VALUES ($1,'backstock',$2,true) RETURNING id`, [tenant, `${runId} location`]);
    location = Number(loc.rows[0].id);
    const product = await client.query(`INSERT INTO catalog_items (tenant_id,name,category,price,is_available,is_woo_managed,is_local_alavont) VALUES ($1,$2,'test',10,true,false,true) RETURNING id`, [tenant, `${runId} product`]);
    item = Number(product.rows[0].id);
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    await client.query(`DELETE FROM payment_attempts WHERE tenant_id IN ($1,$2)`, [tenant, foreignTenant]);
    await client.query(`DELETE FROM audit_logs WHERE tenant_id IN ($1,$2)`, [tenant, foreignTenant]);
    await client.query(`ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_immutable_trigger`);
    await client.query(`DELETE FROM inventory_movements WHERE tenant_id IN ($1,$2)`, [tenant, foreignTenant]);
    await client.query(`ALTER TABLE inventory_movements ENABLE TRIGGER inventory_movements_immutable_trigger`);
    await client.query(`DELETE FROM inventory_valuation_states WHERE tenant_id IN ($1,$2)`, [tenant, foreignTenant]);
    await client.query(`DELETE FROM inventory_reservations WHERE order_id IN (SELECT id FROM orders WHERE tenant_id IN ($1,$2))`, [tenant, foreignTenant]);
    await client.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id IN ($1,$2))`, [tenant, foreignTenant]);
    await client.query(`DELETE FROM orders WHERE tenant_id IN ($1,$2)`, [tenant, foreignTenant]);
    await client.query(`DELETE FROM inventory_balances WHERE tenant_id IN ($1,$2)`, [tenant, foreignTenant]);
    await client.query(`DELETE FROM catalog_items WHERE tenant_id IN ($1,$2)`, [tenant, foreignTenant]);
    await client.query(`DELETE FROM inventory_locations WHERE tenant_id IN ($1,$2)`, [tenant, foreignTenant]);
    await client.query(`DELETE FROM users WHERE clerk_id LIKE $1`, [`${runId}%`]);
    await client.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [tenant, foreignTenant]);
    await client.end();
  });

  it("recovers legacy consumption and preserves unknown cost", async () => {
    const order = await makeOrder({ quantity: 2 });
    await client.query(`INSERT INTO inventory_balances (tenant_id,product_id,location_id,quantity_on_hand,par_level) VALUES ($1,$2,$3,0,0) ON CONFLICT (tenant_id,product_id,location_id) DO UPDATE SET quantity_on_hand=0`, [tenant,item,location]);
    await client.query(`INSERT INTO inventory_valuation_states (tenant_id,inventory_entity_type,catalog_item_id,cost_status,known_quantity,inventory_value) VALUES ($1,'catalog',$2,'unknown_baseline',0,NULL) ON CONFLICT (tenant_id,catalog_item_id) WHERE catalog_item_id IS NOT NULL DO UPDATE SET cost_status='unknown_baseline',known_quantity=0,inventory_value=NULL,average_unit_cost=NULL`, [tenant,item]);
    const result = await recovery(order.orderId, key("success"));
    expect(result.finalStatus).toBe("cancelled");
    expect(result.restoredQuantity).toBe("2");
    const state = await client.query(`SELECT quantity_on_hand FROM inventory_balances WHERE tenant_id=$1 AND product_id=$2 AND location_id=$3`, [tenant,item,location]);
    expect(state.rows[0].quantity_on_hand).toBe("2.000");
    const movement = await client.query(`SELECT movement_type,unit_cost,extended_cost,source_type FROM inventory_movements WHERE order_id=$1`, [order.orderId]);
    expect(movement.rows).toHaveLength(1); expect(movement.rows[0]).toMatchObject({ movement_type: "correction", unit_cost: null, extended_cost: null, source_type: "prelaunch_test_order_void" });
    expect((await client.query(`SELECT count(*)::int AS count FROM audit_logs WHERE action='order.prelaunch_test_void' AND resource_id=$1`, [String(order.orderId)])).rows[0].count).toBe(1);
  });

  it("is idempotent and harmless after recovery", async () => {
    const order = await makeOrder({ quantity: 1 });
    await client.query(`INSERT INTO inventory_balances (tenant_id,product_id,location_id,quantity_on_hand,par_level) VALUES ($1,$2,$3,0,0) ON CONFLICT (tenant_id,product_id,location_id) DO UPDATE SET quantity_on_hand=0`, [tenant,item,location]);
    await client.query(`INSERT INTO inventory_valuation_states (tenant_id,inventory_entity_type,catalog_item_id,cost_status,known_quantity,inventory_value) VALUES ($1,'catalog',$2,'unknown_baseline',0,NULL) ON CONFLICT (tenant_id,catalog_item_id) WHERE catalog_item_id IS NOT NULL DO UPDATE SET cost_status='unknown_baseline',known_quantity=0,inventory_value=NULL,average_unit_cost=NULL`, [tenant,item]);
    const first = await recovery(order.orderId, key("idem")); const second = await recovery(order.orderId, key("idem"));
    expect(first.idempotent).toBe(false); expect(second.idempotent).toBe(true); expect(second.restoredQuantity).toBe("0");
    expect((await client.query(`SELECT count(*)::int AS count FROM inventory_movements WHERE order_id=$1`, [order.orderId])).rows[0].count).toBe(1);
  });

  it("blocks payment, tenant, and role violations before mutation", async () => {
    const paid = await makeOrder({ payment: true });
    await expect(recovery(paid.orderId, key("paid"))).rejects.toMatchObject({ status: 409 });
    expect((await client.query(`SELECT status FROM orders WHERE id=$1`, [paid.orderId])).rows[0].status).toBe("ready");
    const foreignOrder = await makeOrder();
    await expect(recovery(foreignOrder.orderId, key("tenant"), actor(admin), foreignTenant)).rejects.toMatchObject({ status: 404 });
    await expect(recovery(foreignOrder.orderId, key("role"), actor(ordinary, "user"))).rejects.toMatchObject({ status: 403 });
  });

  it("rolls back all work when a later item has known cost", async () => {
    const order = await makeOrder({ quantity: 1 });
    const second = await client.query(`INSERT INTO catalog_items (tenant_id,name,category,price,is_available,is_woo_managed,is_local_alavont) VALUES ($1,$2,'test',10,true,false,true) RETURNING id`, [tenant, `${runId} second`]);
    await client.query(`INSERT INTO order_items (order_id,catalog_item_id,catalog_item_name,quantity,unit_price,total_price) VALUES ($1,$2,$3,1,10,10)`, [order.orderId, second.rows[0].id, `${runId} second`]);
    await client.query(`INSERT INTO inventory_reservations (order_id,catalog_item_id,location_id,quantity,status,expires_at) VALUES ($1,$2,$3,1,'confirmed',now()+interval '1 hour')`, [order.orderId, second.rows[0].id, location]);
    await client.query(`INSERT INTO inventory_balances (tenant_id,product_id,location_id,quantity_on_hand,par_level) VALUES ($1,$2,$3,0,0),($1,$4,$3,0,0) ON CONFLICT (tenant_id,product_id,location_id) DO UPDATE SET quantity_on_hand=0`, [tenant,item,location,second.rows[0].id]);
    await client.query(`INSERT INTO inventory_valuation_states (tenant_id,inventory_entity_type,catalog_item_id,cost_status,known_quantity,inventory_value) VALUES ($1,'catalog',$2,'unknown_baseline',0,NULL),($1,'catalog',$3,'known',0,0) ON CONFLICT DO NOTHING`, [tenant,item,second.rows[0].id]);
    await expect(recovery(order.orderId, key("rollback"))).rejects.toBeInstanceOf(PrelaunchTestVoidError);
    expect((await client.query(`SELECT status FROM orders WHERE id=$1`, [order.orderId])).rows[0].status).toBe("ready");
    expect((await client.query(`SELECT count(*)::int AS count FROM inventory_movements WHERE order_id=$1`, [order.orderId])).rows[0].count).toBe(0);
    expect((await client.query(`SELECT count(*)::int AS count FROM audit_logs WHERE action='order.prelaunch_test_void' AND resource_id=$1`, [String(order.orderId)])).rows[0].count).toBe(0);
  });
});
