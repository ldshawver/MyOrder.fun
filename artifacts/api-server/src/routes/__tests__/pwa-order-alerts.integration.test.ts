/** Disposable migrated clone only: RUN_PWA_ORDER_ALERTS_INTEGRATION=1. */
import { randomUUID } from "node:crypto";
import express from "express";
import pg from "pg";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ delivery: vi.fn(async () => ({ attempted: 1, sent: 1, failed: 0, retryable: 0, uncertain: 0, skipped: false })) }));
const enabled = process.env.RUN_PWA_ORDER_ALERTS_INTEGRATION === "1";
const header = "x-pwa-alert-test-user";
vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header(header) }),
  clerkClient: { users: { getUser: vi.fn().mockResolvedValue({ publicMetadata: {} }) } },
}));
vi.mock("../../lib/pwaPushSender", async importOriginal => {
  const actual = await importOriginal<typeof import("../../lib/pwaPushSender")>();
  return { ...actual, isPwaPushConfigured: () => true, sendPwaPushToUser: state.delivery };
});

import router from "../pwa-push";

const { Client } = pg;
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const identities = { admin: `pwa-admin-${suffix}`, viewer: `pwa-viewer-${suffix}`, foreign: `pwa-foreign-${suffix}` };
let client: pg.Client;
let tenantA: number; let adminId: number;
const app = express(); app.use(express.json()); app.use("/api", router);
const http = supertest(app);
const as = (who: keyof typeof identities) => ({ get: (path: string) => http.get(path).set(header, identities[who]),
  post: (path: string) => http.post(path).set(header, identities[who]), put: (path: string) => http.put(path).set(header, identities[who]) });

(enabled ? describe : describe.skip)("per-user browser order alerts on a disposable migrated clone", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/(?:127\.0\.0\.1|localhost):\d+\//);
    client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false }); await client.connect();
    const tenants = await client.query<{ id: number }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active'),($3,$4,'active') RETURNING id",
      [`PWA alerts A ${suffix}`, `pwa-alerts-a-${suffix}`, `PWA alerts B ${suffix}`, `pwa-alerts-b-${suffix}`]);
    tenantA = tenants.rows[0]!.id;
    const users = await client.query<{ id: number }>(`INSERT INTO users(clerk_id,email,normalized_email,role,tenant_id,status,is_active,identity_status,provisioning_status)
      VALUES($1,$2,$2,'admin',$3,'approved',true,'verified','active'),($4,$5,$5,'user',$3,'approved',true,'verified','active'),($6,$7,$7,'admin',$8,'approved',true,'verified','active') RETURNING id`,
    [identities.admin, `${identities.admin}@example.test`, tenantA, identities.viewer, `${identities.viewer}@example.test`, identities.foreign, `${identities.foreign}@example.test`, tenants.rows[1]!.id]);
    adminId = users.rows[0]!.id;
  });
  afterAll(async () => { if (client) await client.end(); });

  it("registers, persists, tests through push delivery, disables and isolates the preference", async () => {
    const endpoint = `https://push.example.test/${suffix}`;
    const subscription = await as("admin").post("/api/pwa/push/subscribe").send({
      subscription: { endpoint, keys: { p256dh: "fixture-public", auth: "fixture-auth" } },
      device: { id: `browser-${suffix}`, userAgent: "test browser", platform: "desktop" },
    });
    expect(subscription.status, subscription.text).toBe(200);
    expect((await as("admin").get("/api/pwa/push/order-alerts")).body).toMatchObject({ enabled: false, activeSubscriptionCount: 1 });
    const unauthorized = await as("viewer").put("/api/pwa/push/order-alerts").send({ enabled: true });
    expect(unauthorized.status).toBe(403);
    const injectedTenant = await as("admin").put("/api/pwa/push/order-alerts").send({ enabled: true, tenantId: tenantA + 999 });
    expect(injectedTenant.status).toBe(400);
    const on = await as("admin").put("/api/pwa/push/order-alerts").send({ enabled: true });
    expect(on.status, on.text).toBe(200); expect(on.body.enabled).toBe(true);
    state.delivery.mockClear();
    const testPush = await as("admin").post("/api/pwa/push/order-alerts/test");
    expect(testPush.status, testPush.text).toBe(200);
    expect(state.delivery).toHaveBeenCalledWith(expect.objectContaining({ tenantId: tenantA, userId: adminId, payload: expect.objectContaining({ type: "order", title: "MyOrder test alert" }) }));
    const off = await as("admin").put("/api/pwa/push/order-alerts").send({ enabled: false });
    expect(off.status, off.text).toBe(200); expect(off.body.enabled).toBe(false);
    expect((await as("admin").get("/api/pwa/push/order-alerts")).body.enabled).toBe(false);
    expect((await client.query<{ is_active: boolean }>("SELECT is_active FROM pwa_push_subscriptions WHERE endpoint=$1", [endpoint])).rows[0]!.is_active).toBe(false);
    const disabledTest = await as("admin").post("/api/pwa/push/order-alerts/test");
    expect(disabledTest.status).toBe(409);
    expect((await as("foreign").get("/api/pwa/push/order-alerts")).status).toBe(200);
    expect((await as("foreign").get("/api/pwa/push/order-alerts")).body).toMatchObject({ enabled: false, activeSubscriptionCount: 0 });
  });
});
