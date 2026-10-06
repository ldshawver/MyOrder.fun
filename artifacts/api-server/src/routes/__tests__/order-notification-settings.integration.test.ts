/** Run only against a disposable localhost migrated clone. */
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import pg from "pg";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = process.env.RUN_ORDER_NOTIFICATION_INTEGRATION === "1";
const header = "x-notification-test-user";
vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({ userId: req.header(header) }),
  clerkClient: { users: { getUser: vi.fn().mockResolvedValue({ publicMetadata: {} }) } },
}));

import router from "../order-notification-settings";

const { Client } = pg;
const suffix = randomUUID().slice(0, 10);
const identities = { admin: `notification_admin_${suffix}`, supervisor: `notification_supervisor_${suffix}`,
  viewer: `notification_viewer_${suffix}`, foreignAdmin: `notification_foreign_${suffix}` };
let client: pg.Client;
let tenantA: number;
let adminId: number;
let foreignId: number;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never; next(); });
app.use("/api", router);
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => res.status(500).json({ error: String(error) });
app.use(errorHandler);
const http = supertest(app);
const payload = (recipient: number) => ({ lightEnabled: false, smsEnabled: false,
  alertDurationSeconds: 60, generalAssigneeUserId: recipient, generalFallbackUserId: null });
const put = (user: keyof typeof identities, body: unknown) =>
  http.put("/api/admin/order-notifications").set(header, identities[user]).send(body);

(enabled ? describe : describe.skip)("notification settings authorization on migrated clone", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/(?:127\.0\.0\.1|localhost):\d+\//);
    client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await client.connect();
    const tenants = await client.query<{ id: number }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active'),($3,$4,'active') RETURNING id",
      [`Notification settings A ${suffix}`, `notification-settings-a-${suffix}`, `Notification settings B ${suffix}`, `notification-settings-b-${suffix}`]);
    tenantA = tenants.rows[0]!.id;
    const users = await client.query<{ id: number }>(`INSERT INTO users(clerk_id,email,normalized_email,role,tenant_id,status,is_active,identity_status,provisioning_status)
      VALUES($1,$2,$2,'admin',$3,'approved',true,'verified','active'),
      ($4,$5,$5,'supervisor',$3,'approved',true,'verified','active'),
      ($6,$7,$7,'user',$3,'approved',true,'verified','active'),
      ($8,$9,$9,'admin',$10,'approved',true,'verified','active') RETURNING id`,
      [identities.admin,`${identities.admin}@example.test`,tenantA,
        identities.supervisor,`${identities.supervisor}@example.test`,
        identities.viewer,`${identities.viewer}@example.test`,
        identities.foreignAdmin,`${identities.foreignAdmin}@example.test`,tenants.rows[1]!.id]);
    adminId = users.rows[0]!.id;
    foreignId = users.rows[3]!.id;
  });
  afterAll(async () => { if (client) await client.end(); });

  it("rejects unauthenticated, ordinary, Supervisor and foreign-recipient mutations without settings or audit changes", async () => {
    const attempts = [
      http.put("/api/admin/order-notifications").send(payload(adminId)),
      put("viewer", payload(adminId)),
      put("supervisor", payload(adminId)),
      put("admin", payload(foreignId)),
      put("admin", { ...payload(adminId), recipientPhone: "+15550000000" }),
      put("admin", { ...payload(adminId), tenantId: 1 }),
    ];
    for (const request of attempts) {
      const response = await request;
      expect([400, 401, 403, 404]).toContain(response.status);
      expect((await client.query("SELECT count(*)::int AS n FROM order_notification_settings WHERE tenant_id=$1", [tenantA])).rows[0].n).toBe(0);
      expect((await client.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND action='order_notifications.settings_updated'", [tenantA])).rows[0].n).toBe(0);
    }
  }, 30_000);

  it("allows tenant Admin to set an explicit recipient and records a matching audit", async () => {
    const response = await put("admin", payload(adminId));
    expect(response.status, response.text).toBe(200);
    expect(response.body).not.toHaveProperty("phone");
    const saved = await client.query("SELECT general_assignee_user_id,sms_enabled,light_enabled FROM order_notification_settings WHERE tenant_id=$1", [tenantA]);
    expect(saved.rows[0]).toMatchObject({ general_assignee_user_id: adminId, sms_enabled: false, light_enabled: false });
    expect((await client.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND action='order_notifications.settings_updated'", [tenantA])).rows[0].n).toBe(1);
    const get = await http.get("/api/admin/order-notifications").set(header, identities.admin);
    expect(get.status).toBe(200);
    expect(JSON.stringify(get.body)).not.toMatch(/\+1555|TWILIO_AUTH_TOKEN|TUYA_CLIENT_SECRET/);
  });
});
