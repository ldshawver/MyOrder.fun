/** Disposable migrated clone only: RUN_ORDER_NOTIFICATION_INTEGRATION=1. */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@workspace/db";
import { chooseStaffRecipient, enqueueOrderCreated, NotificationFailure, processDueLightOff,
  processOneNotificationJob, type NotificationProviders } from "../orderNotifications";

const enabled = process.env.RUN_ORDER_NOTIFICATION_INTEGRATION === "1";
const { Pool } = pg;
let pool: pg.Pool;
let tenantA: number;
let tenantB: number;
let customer: number;
let csr: number;
let admin: number;
let supervisor: number;
const suffix = randomUUID().slice(0, 8);
const phones = { csr: "+15550001111", admin: "+15550002222", supervisor: "+15550003333" };
async function createOrder(tenantId = tenantA, assigned?: { userId: number; shiftId: number }) {
  const result = await pool.query<{ id: number; created_at: Date }>(`INSERT INTO orders(tenant_id,customer_id,subtotal,tax,total,status,payment_status,
    assigned_csr_user_id,assigned_shift_id,routed_to,route_source) VALUES($1,$2,10,0,10,'submitted','unpaid',$3,$4,$5,$6)
    RETURNING id,created_at`, [tenantId, customer, assigned?.userId ?? null, assigned?.shiftId ?? null,
      assigned ? "csr_shift" : "default_queue", assigned ? "active_csr" : "general_account"]);
  return result.rows[0]!;
}
async function count(orderId: number) {
  const result = await pool.query<{ events: string; jobs: string }>(`SELECT
    (SELECT count(*) FROM order_notification_events WHERE tenant_id=$1 AND order_id=$2) AS events,
    (SELECT count(*) FROM order_notification_jobs WHERE tenant_id=$1 AND order_id=$2) AS jobs`, [tenantA, orderId]);
  return { events: Number(result.rows[0]?.events), jobs: Number(result.rows[0]?.jobs) };
}
const config = { light_enabled: true, sms_enabled: true, alert_duration_seconds: 60,
  general_assignee_user_id: null as number | null, general_fallback_user_id: null as number | null };

(enabled ? describe : describe.skip)("durable order-created notifications on migrated clone", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/(?:127\.0\.0\.1|localhost):\d+\//);
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, ssl: false });
    const tenants = await pool.query<{ id: number }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active'),($3,$4,'active') RETURNING id",
      [`Notification A ${suffix}`, `notification-a-${suffix}`, `Notification B ${suffix}`, `notification-b-${suffix}`]);
    tenantA = tenants.rows[0]!.id; tenantB = tenants.rows[1]!.id;
    const users = await pool.query<{ id: number }>(`INSERT INTO users(clerk_id,email,normalized_email,role,tenant_id,status,is_active,identity_status,provisioning_status,contact_phone)
      VALUES($1,$2,$2,'user',$3,'approved',true,'verified','active',NULL),
      ($4,$5,$5,'csr',$3,'approved',true,'verified','active',$6),
      ($7,$8,$8,'admin',$3,'approved',true,'verified','active',$9),
      ($10,$11,$11,'supervisor',$3,'approved',true,'verified','active',$12)
      RETURNING id`, [`notify-customer-${suffix}`,`customer-${suffix}@example.test`,tenantA,
        `notify-csr-${suffix}`,`csr-${suffix}@example.test`,phones.csr,
        `notify-admin-${suffix}`,`admin-${suffix}@example.test`,phones.admin,
        `notify-supervisor-${suffix}`,`supervisor-${suffix}@example.test`,phones.supervisor]);
    [customer, csr, admin, supervisor] = users.rows.map(row => row.id);
    await pool.query("INSERT INTO order_notification_settings(tenant_id,light_enabled,sms_enabled,alert_duration_seconds,general_assignee_user_id,general_fallback_user_id) VALUES($1,true,true,60,$2,$3)", [tenantA, admin, supervisor]);
    process.env.TUYA_TENANT_ID = String(tenantA);
  });
  afterAll(async () => { if (pool) await pool.end(); });

  it("commits one event and two jobs; duplicate enqueue and rollback create no duplicates", async () => {
    const order = await createOrder();
    await db.transaction(async tx => { await enqueueOrderCreated(tx, tenantA, order.id, order.created_at); });
    expect(await count(order.id)).toEqual({ events: 1, jobs: 2 });
    const deadline = (await pool.query<{ off_at: Date }>("SELECT off_at FROM order_light_alerts WHERE tenant_id=$1", [tenantA])).rows[0]!.off_at;
    await db.transaction(async tx => { await enqueueOrderCreated(tx, tenantA, order.id, order.created_at); });
    expect(await count(order.id)).toEqual({ events: 1, jobs: 2 });
    expect((await pool.query<{ off_at: Date }>("SELECT off_at FROM order_light_alerts WHERE tenant_id=$1", [tenantA])).rows[0]!.off_at).toEqual(deadline);
    let rolledId = 0;
    await expect(db.transaction(async tx => {
      const result = await tx.execute(sql`INSERT INTO orders(tenant_id,customer_id,subtotal,tax,total,status,payment_status)
        VALUES(${tenantA},${customer},10,0,10,'submitted','unpaid') RETURNING id,created_at`);
      const row = (Array.isArray(result) ? result : result.rows)[0] as { id: number; created_at: Date };
      rolledId = row.id;
      await enqueueOrderCreated(tx, tenantA, row.id, row.created_at);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await count(rolledId)).toEqual({ events: 0, jobs: 0 });
    expect((await pool.query("SELECT id FROM orders WHERE id=$1", [rolledId])).rows).toHaveLength(0);
  });

  it("routes only to the assigned on-shift CSR, then explicit General Queue assignee/fallback", async () => {
    const shift = await pool.query<{ id: number }>(`INSERT INTO lab_tech_shifts(tenant_id,tech_id,status,box_assignment_id) VALUES($1,$2,'active','sales-box-1') RETURNING id`, [tenantA, csr]);
    const assigned = await createOrder(tenantA, { userId: csr, shiftId: shift.rows[0]!.id });
    expect((await chooseStaffRecipient(pool, tenantA, assigned.id, config))?.id).toBe(csr);
    await pool.query("UPDATE lab_tech_shifts SET status='completed',clocked_out_at=now() WHERE id=$1", [shift.rows[0]!.id]);
    expect(await chooseStaffRecipient(pool, tenantA, assigned.id, config)).toBeNull();
    expect((await chooseStaffRecipient(pool, tenantA, assigned.id, { ...config, general_fallback_user_id: supervisor }))?.id).toBe(supervisor);
    const general = await createOrder();
    expect((await chooseStaffRecipient(pool, tenantA, general.id, { ...config, general_assignee_user_id: admin }))?.id).toBe(admin);
    expect((await chooseStaffRecipient(pool, tenantA, general.id, { ...config, general_assignee_user_id: supervisor }))?.id).toBe(supervisor);
    expect(await chooseStaffRecipient(pool, tenantA, general.id, config)).toBeNull();
    expect(await chooseStaffRecipient(pool, tenantB, general.id, { ...config, general_assignee_user_id: admin })).toBeNull();
  });

  it("extends overlapping alert windows and ignores a stale OFF deadline", async () => {
    await pool.query("DELETE FROM order_notification_jobs WHERE tenant_id=$1", [tenantA]);
    await pool.query("DELETE FROM order_notification_events WHERE tenant_id=$1", [tenantA]);
    await pool.query("DELETE FROM order_light_alerts WHERE tenant_id=$1", [tenantA]);
    await pool.query("UPDATE order_notification_settings SET sms_enabled=false WHERE tenant_id=$1", [tenantA]);
    const first = await createOrder();
    await db.transaction(async tx => enqueueOrderCreated(tx, tenantA, first.id, new Date(Date.now() - 40_000)));
    const second = await createOrder();
    await db.transaction(async tx => enqueueOrderCreated(tx, tenantA, second.id, second.created_at));
    const light = vi.fn(async (_on: boolean) => {});
    const providers: NotificationProviders = { light, sms: vi.fn(async () => "SM_TEST") };
    for (let i = 0; i < 4; i++) await processOneNotificationJob(pool, providers, tenantA);
    expect(light).toHaveBeenCalledWith(true);
    expect(light.mock.calls.filter(call => call[0] === true)).toHaveLength(1);
    const deadline = (await pool.query<{ off_at: Date; generation: string }>("SELECT off_at,generation FROM order_light_alerts WHERE tenant_id=$1", [tenantA])).rows[0]!;
    expect(deadline.off_at.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(await processDueLightOff(pool, providers)).toBe(false);
    expect(light.mock.calls.filter(call => call[0] === false)).toHaveLength(0);
    await pool.query("UPDATE order_light_alerts SET off_at=now()-interval '1 second' WHERE tenant_id=$1", [tenantA]);
    expect(await processDueLightOff(pool, providers)).toBe(true);
    expect(light.mock.calls.filter(call => call[0] === false)).toHaveLength(1);
  });

  it("retries failed OFF and never retries ambiguous SMS", async () => {
    await pool.query("UPDATE order_light_alerts SET is_on=true,off_at=now()-interval '1 second',off_next_attempt_at=NULL WHERE tenant_id=$1", [tenantA]);
    let offCalls = 0;
    const light = vi.fn(async (on: boolean) => { if (!on && ++offCalls === 1) throw new NotificationFailure("transient"); });
    const providers: NotificationProviders = { light, sms: vi.fn(async () => "SM_TEST") };
    expect(await processDueLightOff(pool, providers)).toBe(true);
    expect((await pool.query<{ is_on: boolean }>("SELECT is_on FROM order_light_alerts WHERE tenant_id=$1", [tenantA])).rows[0]!.is_on).toBe(true);
    await pool.query("UPDATE order_light_alerts SET off_next_attempt_at=now()-interval '1 second' WHERE tenant_id=$1", [tenantA]);
    expect(await processDueLightOff(pool, providers)).toBe(true);
    expect(offCalls).toBe(2);
    await pool.query("UPDATE order_notification_settings SET sms_enabled=true WHERE tenant_id=$1", [tenantA]);
    const order = await createOrder();
    await db.transaction(async tx => enqueueOrderCreated(tx, tenantA, order.id, order.created_at));
    const uncertain = vi.fn(async () => { throw new NotificationFailure("uncertain"); });
    const smsProviders: NotificationProviders = { light: vi.fn(async () => {}), sms: uncertain };
    for (let i = 0; i < 3; i++) await processOneNotificationJob(pool, smsProviders, tenantA);
    expect(uncertain).toHaveBeenCalledTimes(1);
    expect((await pool.query<{ state: string }>("SELECT state FROM order_notification_jobs WHERE tenant_id=$1 AND order_id=$2 AND notification_type='staff_sms'", [tenantA, order.id])).rows[0]!.state).toBe("uncertain");
  });

  it("serializes simultaneous orders and keeps the latest durable OFF deadline", async () => {
    const orders = await Promise.all(Array.from({ length: 6 }, () => createOrder()));
    const times = orders.map((_, index) => new Date(Date.now() + index * 1_000));
    await Promise.all(orders.map((order, index) =>
      db.transaction(async tx => enqueueOrderCreated(tx, tenantA, order.id, times[index]!))));
    const alert = (await pool.query<{ off_at: Date; generation: string }>(
      "SELECT off_at,generation FROM order_light_alerts WHERE tenant_id=$1", [tenantA])).rows[0]!;
    expect(alert.off_at.getTime()).toBeGreaterThanOrEqual(times[5]!.getTime() + 60_000);
    for (const order of orders) expect(await count(order.id)).toEqual({ events: 1, jobs: 2 });
  });
});
