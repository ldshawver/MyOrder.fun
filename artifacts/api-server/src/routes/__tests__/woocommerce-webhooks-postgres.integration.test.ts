import express from "express";
import supertest from "supertest";
import { Pool } from "pg";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";

const pgHarness = vi.hoisted(() => ({
  statusCodes: [] as number[],
  delayMs: 0,
  fetchCalls: 0,
}));

vi.mock("../../lib/wooSafeHttp", async importOriginal => {
  const actual = await importOriginal<typeof import("../../lib/wooSafeHttp")>();
  return {
    ...actual,
    fetchWooSafely: vi.fn(async () => {
      pgHarness.fetchCalls++;
      if (pgHarness.delayMs) await new Promise(resolve => setTimeout(resolve, pgHarness.delayMs));
      const status = pgHarness.statusCodes.shift() ?? 200;
      return new Response(JSON.stringify({
        id: 25,
        name: "Webhook PostgreSQL Fixture",
        type: "simple",
        price: "12.50",
        regular_price: "12.50",
        sale_price: "",
        categories: [{ name: "Fixtures" }],
        images: [],
        stock_status: "instock",
        catalog_visibility: "visible",
      }), { status, headers: { "content-type": "application/json", "X-WP-TotalPages": "1" } });
    }),
  };
});

import { createHmac } from "node:crypto";
import router from "../woocommerce-webhooks";

const enabled = process.env.RUN_WOO_WEBHOOK_PG_INTEGRATION === "1";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === "false" ? false : undefined });
const suffix = `${process.pid}-${Date.now()}`;
const createdTenantIds: number[] = [];
let fixtureIndex = 0;

function server() {
  const app = express();
  app.use("/api/webhooks/woocommerce", express.raw({ type: "application/json", limit: "1mb" }));
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((err as { status?: number }).status ?? 500).json({ error: "Request rejected" });
  });
  return app;
}

async function createTenant(label: string): Promise<{ id: number; origin: string; secret: string }> {
  fixtureIndex++;
  const slug = `woo-auth-${suffix}-${label}-${fixtureIndex}`;
  const origin = `https://${slug}.example`;
  const secret = `synthetic-${slug}-secret`;
  const inserted = await pool.query<{ id: number }>(
    "INSERT INTO tenants (name, slug, status) VALUES ($1, $2, 'active') RETURNING id",
    [`Woo webhook ${label}`, slug],
  );
  const id = inserted.rows[0]!.id;
  createdTenantIds.push(id);
  await pool.query(
    `INSERT INTO admin_settings (tenant_id, wc_store_url, wc_consumer_key, wc_consumer_secret, wc_webhook_secret)
     VALUES ($1, $2, 'synthetic-consumer-key', 'synthetic-consumer-secret', $3)`,
    [id, origin, secret],
  );
  return { id, origin, secret };
}

function sign(raw: string, secret: string): string {
  return createHmac("sha256", secret).update(raw).digest("base64");
}

function send(input: { origin: string; secret: string; deliveryId: string; tenantId?: number }) {
  const raw = JSON.stringify({
    id: 25,
    name: "Webhook PostgreSQL Fixture",
    tenant_id: input.tenantId ?? 999999,
    account_id: "untrusted-account",
    integration_id: 999999,
    store_id: 999999,
  });
  return supertest(server()).post("/api/webhooks/woocommerce")
    .set("Content-Type", "application/json")
    .set("X-WC-Webhook-Signature", sign(raw, input.secret))
    .set("X-WC-Webhook-Source", input.origin)
    .set("X-WC-Webhook-Delivery-ID", input.deliveryId)
    .set("X-WC-Webhook-Topic", "product.updated")
    .send(raw);
}

async function event(tenantId: number, deliveryId: string) {
  const result = await pool.query<{ status: string; attempt_count: number }>(
    "SELECT status, attempt_count FROM woocommerce_webhook_events WHERE tenant_id = $1 AND delivery_id = $2",
    [tenantId, deliveryId],
  );
  return result.rows[0];
}

async function catalogCount(tenantId: number) {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM catalog_items WHERE tenant_id = $1 AND woo_product_id = '25'",
    [tenantId],
  );
  return Number(result.rows[0]!.count);
}

describe.skipIf(!enabled)("WooCommerce webhook PostgreSQL integration", () => {
  beforeAll(async () => {
    expect(process.env.TEST_DISPOSABLE_CLONE).toBe("I_UNDERSTAND_THIS_CLONE_IS_TRUNCATED");
    const identity = await pool.query<{ version: string; database: string; ledger_count: string }>(
      `SELECT current_setting('server_version') AS version, current_database() AS database,
        (SELECT count(*)::text FROM drizzle.__drizzle_migrations) AS ledger_count`,
    );
    expect(identity.rows[0]?.version).toMatch(/^16\./);
    expect(identity.rows[0]?.database).toBe("myorder_woo_auth_test");
    expect(identity.rows[0]?.ledger_count).toBe("49");
    const marker = await pool.query("SELECT 1 FROM public.myorder_hotfix_migrations WHERE migration_id='p0_owner_approval_provenance'");
    expect(marker.rowCount).toBe(1);
  });

  afterEach(async () => {
    pgHarness.statusCodes = [];
    pgHarness.delayMs = 0;
    pgHarness.fetchCalls = 0;
    if (createdTenantIds.length) {
      await pool.query("DELETE FROM woocommerce_webhook_events WHERE tenant_id = ANY($1::int[])", [createdTenantIds]);
      await pool.query("DELETE FROM catalogue_options WHERE tenant_id = ANY($1::int[])", [createdTenantIds]);
      await pool.query("DELETE FROM catalogue_products WHERE tenant_id = ANY($1::int[])", [createdTenantIds]);
      await pool.query("DELETE FROM inventory_items WHERE tenant_id = ANY($1::int[])", [createdTenantIds]);
      await pool.query("DELETE FROM catalog_items WHERE tenant_id = ANY($1::int[])", [createdTenantIds]);
      await pool.query("DELETE FROM admin_settings WHERE tenant_id = ANY($1::int[])", [createdTenantIds]);
      await pool.query("DELETE FROM tenants WHERE id = ANY($1::int[])", [createdTenantIds]);
      createdTenantIds.length = 0;
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("binds tenant from configured source despite tenant-like payload fields", async () => {
    const tenantA = await createTenant("a");
    const tenantB = await createTenant("b");
    const response = await send({ origin: tenantA.origin, secret: tenantA.secret, deliveryId: "tenant-binding", tenantId: tenantB.id });
    expect(response.status).toBe(200);
    expect((await event(tenantA.id, "tenant-binding"))?.status).toBe("processed");
    expect(await catalogCount(tenantA.id)).toBe(1);
    expect(await catalogCount(tenantB.id)).toBe(0);

    const foreignSecret = await send({ origin: tenantB.origin, secret: tenantA.secret, deliveryId: "foreign-secret", tenantId: tenantA.id });
    expect(foreignSecret.status).toBe(401);
    expect(await event(tenantB.id, "foreign-secret")).toBeUndefined();
    expect(await catalogCount(tenantB.id)).toBe(0);
  });

  it("serializes concurrent duplicate delivery and acknowledges completed replay", async () => {
    const tenant = await createTenant("concurrent");
    pgHarness.delayMs = 200;
    const [first, second] = await Promise.all([
      send({ origin: tenant.origin, secret: tenant.secret, deliveryId: "concurrent-delivery" }),
      send({ origin: tenant.origin, secret: tenant.secret, deliveryId: "concurrent-delivery" }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 503]);
    expect((await event(tenant.id, "concurrent-delivery"))?.status).toBe("processed");
    expect(await catalogCount(tenant.id)).toBe(1);
    expect(pgHarness.fetchCalls).toBe(1);

    const replay = await send({ origin: tenant.origin, secret: tenant.secret, deliveryId: "concurrent-delivery" });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ok: true, duplicate: true });
    expect(await catalogCount(tenant.id)).toBe(1);
    expect(pgHarness.fetchCalls).toBe(1);
  });

  it("retries failed work and recovers a stale processing claim without duplicate catalog rows", async () => {
    const tenant = await createTenant("recovery");
    pgHarness.statusCodes = [503, 200];
    const failed = await send({ origin: tenant.origin, secret: tenant.secret, deliveryId: "failure-retry" });
    expect(failed.status).toBe(503);
    expect((await event(tenant.id, "failure-retry"))?.status).toBe("failed");
    const retried = await send({ origin: tenant.origin, secret: tenant.secret, deliveryId: "failure-retry" });
    expect(retried.status).toBe(200);
    expect((await event(tenant.id, "failure-retry"))?.status).toBe("processed");
    expect(await catalogCount(tenant.id)).toBe(1);

    await pool.query(`UPDATE woocommerce_webhook_events SET status='processing', processed_at=NULL,
      updated_at=now() - interval '6 minutes' WHERE tenant_id=$1 AND delivery_id='failure-retry'`, [tenant.id]);
    const recovered = await send({ origin: tenant.origin, secret: tenant.secret, deliveryId: "failure-retry" });
    expect(recovered.status).toBe(200);
    expect((await event(tenant.id, "failure-retry"))?.attempt_count).toBe(3);
    expect(await catalogCount(tenant.id)).toBe(1);
  });
});
