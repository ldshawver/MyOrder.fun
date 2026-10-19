import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import type { Pool } from "pg";

const clerkState = vi.hoisted(() => ({ userId: "", sessionClaims: {} as Record<string, unknown> }));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({ userId: clerkState.userId, sessionClaims: clerkState.sessionClaims })),
  clerkClient: { users: { getUser: vi.fn(async () => ({ emailAddresses: [] })), updateUserMetadata: vi.fn(async () => ({})) } },
}));

const databaseUrl = process.env.MYORDER_OWNER_APPROVAL_DATABASE_URL;
const pgSuite = databaseUrl ? describe : describe.skip;

pgSuite("platform authorization boundaries against disposable PostgreSQL 16", () => {
  let pool: Pool;
  let tenantA: number;
  let tenantB: number;
  let userA: number;
  let userB: number;
  let globalUser: number;
  let ordinaryUser: number;
  let pendingUser: number;
  let orderA: number;
  let orderB: number;
  let onboardingId: number;
  let originalOrderStates: Array<{ id: number; status: string | null }> = [];
  let originalNotificationStates: Array<{ id: number; is_read: boolean }> = [];

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!/^localhost$|^127\.0\.0\.1$|^::1$/.test(parsed.hostname) || !/^myorder_p0_owner_approval_/.test(decodeURIComponent(parsed.pathname.slice(1)))) {
      throw new Error("Refusing non-local database outside the repository's disposable P0 PostgreSQL fixture");
    }
    process.env.DATABASE_URL = databaseUrl;
    process.env.DB_SSL = "false";
    process.env.MYORDER_OWNER_CLERK_ID = "platform-owner-fixture";
    const database = await import("@workspace/db");
    pool = database.pool as Pool;
    const version = await pool.query<{ version: number }>("SELECT current_setting('server_version_num')::int AS version");
    if (version.rows[0]!.version < 160000 || version.rows[0]!.version >= 170000) throw new Error("Expected PostgreSQL 16");

    await pool.query(`
      ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending';
      ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'paid';
      ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'cash';
      ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
      ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS assigned_csr_user_id integer;
      ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS catalog_item_name text DEFAULT 'fixture item';
      ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS quantity integer DEFAULT 1;
      ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS unit_price numeric(10,2) DEFAULT 1;
      ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS total_price numeric(10,2) DEFAULT 1;
      ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
      CREATE TABLE IF NOT EXISTS public.order_notes (id serial PRIMARY KEY, order_id integer NOT NULL, author_id integer NOT NULL, content text NOT NULL, is_encrypted text NOT NULL DEFAULT 'false', is_internal text NOT NULL DEFAULT 'false', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS public.onboarding_requests (id serial PRIMARY KEY, company_name text NOT NULL, contact_name text NOT NULL, contact_email text NOT NULL, contact_phone text, business_output text NOT NULL, website text, description text, expected_order_volume text, status text NOT NULL DEFAULT 'submitted', review_notes text, reviewed_by integer, tenant_id integer, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    `);
    originalOrderStates = (await pool.query("SELECT id,status FROM public.orders ORDER BY id")).rows;
    originalNotificationStates = (await pool.query("SELECT id,is_read FROM public.notifications ORDER BY id")).rows;
    await pool.query("UPDATE public.orders SET status='delivered'; UPDATE public.notifications SET is_read=true");

    const a = (await pool.query("INSERT INTO public.tenants(name,slug,status) VALUES('Platform boundary tenant A',$1,'active') RETURNING id", [`platform-boundary-a-${process.pid}-${Date.now()}`])).rows[0]!;
    const b = (await pool.query("INSERT INTO public.tenants(name,slug,status) VALUES('Platform boundary tenant B',$1,'active') RETURNING id", [`platform-boundary-b-${process.pid}-${Date.now()}`])).rows[0]!;
    tenantA = a.id; tenantB = b.id;
    async function addUser(clerkId: string, role: string, tenantId: number | null, status = "approved") {
      return (await pool.query(`INSERT INTO public.users(clerk_id,email,normalized_email,first_name,last_name,role,tenant_id,status,is_active,approved_by_clerk_id,approved_at,identity_status,provisioning_status)
        VALUES($1,$2,$2,$1,'Fixture',$3,$4,$5,true,CASE WHEN $5='approved' THEN 'platform-owner-fixture' END,CASE WHEN $5='approved' THEN now() END,'verified','active') RETURNING id`, [clerkId, `${clerkId}@fixture.invalid`, role, tenantId, status])).rows[0]!.id as number;
    }
    userA = await addUser(`boundary-a-${process.pid}`, "tenant_admin", tenantA);
    userB = await addUser(`boundary-b-${process.pid}`, "tenant_admin", tenantB);
    globalUser = await addUser("platform-owner-fixture", "global_admin", null);
    ordinaryUser = await addUser(`boundary-user-${process.pid}`, "user", tenantA);
    pendingUser = await addUser(`boundary-pending-${process.pid}`, "global_admin", null, "pending");

    const aOrder = (await pool.query("INSERT INTO public.orders(tenant_id,customer_id,subtotal,total,status,payment_status,payment_method,assigned_csr_user_id) VALUES($1,$2,15,15,'pending','paid','cash',$2) RETURNING id", [tenantA, userA])).rows[0]!;
    const bOrder = (await pool.query("INSERT INTO public.orders(tenant_id,customer_id,subtotal,total,status,payment_status,payment_method,assigned_csr_user_id) VALUES($1,$2,900,900,'pending','paid','paypal',$2) RETURNING id", [tenantB, userB])).rows[0]!;
    orderA = aOrder.id; orderB = bOrder.id;
    await pool.query("INSERT INTO public.order_items(order_id,catalog_item_id,catalog_item_name,quantity,unit_price,total_price) VALUES($1,1,'Tenant A fixture item',1,15,15),($2,2,'Tenant B secret fixture item',1,900,900)", [orderA, orderB]);
    await pool.query("INSERT INTO public.lab_tech_shifts(tenant_id,tech_id,status,summary,difference_amount,deposit_amount) VALUES($1,$2,'active','{\"totalRevenue\":15,\"orderCount\":1}',0,15),($3,$4,'active','{\"totalRevenue\":900,\"orderCount\":1}',90,900)", [tenantA, userA, tenantB, userB]);
    await pool.query("INSERT INTO public.notifications(user_id,type,title,message,is_read) VALUES($1,'fixture','A unread','fixture',false),($2,'fixture','B unread','fixture',false)", [userA, userB]);
    await pool.query("INSERT INTO public.audit_logs(tenant_id,actor_id,actor_email,actor_role,action,resource_output,resource_id,metadata,ip_address) VALUES($1,$2,'private-b@fixture.invalid','admin','TENANT_B_SECRET','order',$3,'{\"marker\":\"TENANT_B_SECRET\"}','203.0.113.20')", [tenantB, userB, String(orderB)]);
    const onboarding = (await pool.query("INSERT INTO public.onboarding_requests(company_name,contact_name,contact_email,business_output,status) VALUES('Tenant B Confidential LLC','B contact','contact-b@private.invalid','retail','submitted') RETURNING id")).rows[0]!;
    onboardingId = onboarding.id;

    const { default: adminRouter } = await import("../admin");
    const { default: auditRouter } = await import("../audit");
    const { default: onboardingRouter } = await import("../onboarding");
    const { default: reportsRouter } = await import("../reports");
    const withRouter = (router: express.Router) => {
      const app = express();
      app.use(express.json());
      app.use("/api", router);
      app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: error instanceof Error ? error.message : "Unknown route error" });
      });
      return app;
    };
    adminApp = withRouter(adminRouter);
    auditApp = withRouter(auditRouter);
    onboardingApp = withRouter(onboardingRouter);
    reportsApp = withRouter(reportsRouter);
  }, 20000);

  let adminApp: express.Express;
  let auditApp: express.Express;
  let onboardingApp: express.Express;
  let reportsApp: express.Express;

  function as(userId: string, fresh = true) {
    clerkState.userId = userId;
    clerkState.sessionClaims = fresh ? { fva: [1, -1] } : { fva: [11, -1] };
  }

  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM public.notifications WHERE user_id = ANY($1::int[])", [[userA, userB, globalUser, ordinaryUser, pendingUser].filter(Boolean)]);
    await pool.query("DELETE FROM public.audit_logs WHERE tenant_id = ANY($1::int[]) OR actor_id = ANY($2::int[])", [[tenantA, tenantB].filter(Boolean), [userA, userB, globalUser, ordinaryUser, pendingUser].filter(Boolean)]);
    await pool.query("DELETE FROM public.order_notes WHERE order_id = ANY($1::int[])", [[orderA, orderB].filter(Boolean)]);
    await pool.query("DELETE FROM public.order_items WHERE order_id = ANY($1::int[])", [[orderA, orderB].filter(Boolean)]);
    await pool.query("DELETE FROM public.orders WHERE id = ANY($1::int[])", [[orderA, orderB].filter(Boolean)]);
    if (onboardingId) {
      const createdTenant = await pool.query<{ tenant_id: number | null }>("SELECT tenant_id FROM public.onboarding_requests WHERE id=$1", [onboardingId]);
      await pool.query("DELETE FROM public.onboarding_requests WHERE id=$1", [onboardingId]);
      if (createdTenant.rows[0]?.tenant_id) await pool.query("DELETE FROM public.tenants WHERE id=$1", [createdTenant.rows[0].tenant_id]);
    }
    await pool.query("DELETE FROM public.lab_tech_shifts WHERE tenant_id = ANY($1::int[])", [[tenantA, tenantB].filter(Boolean)]);
    await pool.query("DELETE FROM public.users WHERE id = ANY($1::int[])", [[userA, userB, globalUser, ordinaryUser, pendingUser].filter(Boolean)]);
    await pool.query("DELETE FROM public.tenants WHERE id = ANY($1::int[])", [[tenantA, tenantB].filter(Boolean)]);
    for (const row of originalOrderStates) await pool.query("UPDATE public.orders SET status=$2 WHERE id=$1", [row.id, row.status]);
    for (const row of originalNotificationStates) await pool.query("UPDATE public.notifications SET is_read=$2 WHERE id=$1", [row.id, row.is_read]);
    await pool.end();
  });

  it("denies tenant A access to every platform-only route without state changes or data leakage", async () => {
    as(`boundary-a-${process.pid}`);
    const before = await pool.query("SELECT (SELECT count(*) FROM public.tenants) tenants,(SELECT count(*) FROM public.onboarding_requests) onboarding,(SELECT count(*) FROM public.orders) orders,(SELECT count(*) FROM public.notifications) notifications,(SELECT count(*) FROM public.audit_logs) audits");
    const requests = [
      supertest(adminApp).get("/api/admin/stats"),
      supertest(auditApp).get("/api/audit"),
      supertest(onboardingApp).get("/api/onboarding/requests"),
      supertest(onboardingApp).get(`/api/onboarding/requests/${onboardingId}`),
      supertest(onboardingApp).patch(`/api/onboarding/requests/${onboardingId}`).send({ status: "approved" }),
      supertest(adminApp).post("/api/admin/purge").send({ confirm: "PURGE_ALL_SESSIONS" }),
    ];
    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toMatch(/Tenant B Confidential|contact-b@|TENANT_B_SECRET|203\.0\.113\.20/);
    }
    const after = await pool.query("SELECT (SELECT count(*) FROM public.tenants) tenants,(SELECT count(*) FROM public.onboarding_requests) onboarding,(SELECT count(*) FROM public.orders) orders,(SELECT count(*) FROM public.notifications) notifications,(SELECT count(*) FROM public.audit_logs) audits");
    expect(after.rows).toEqual(before.rows);
    expect((await pool.query("SELECT id,tenant_id,status,total FROM public.orders WHERE id=$1", [orderB])).rows[0]).toMatchObject({ id: orderB, tenant_id: tenantB, status: "pending", total: "900.00" });
    expect((await pool.query("SELECT id,is_read FROM public.notifications WHERE user_id=$1 ORDER BY id", [userB])).rowCount).toBe(1);
    expect((await pool.query("SELECT status,tenant_id,reviewed_by FROM public.onboarding_requests WHERE id=$1", [onboardingId])).rows[0]).toMatchObject({ status: "submitted", tenant_id: null, reviewed_by: null });
  });

  it("denies ordinary, unapproved, and unauthenticated actors on platform operations", async () => {
    as(`boundary-user-${process.pid}`);
    expect((await supertest(auditApp).get("/api/audit")).status).toBe(403);
    as(`boundary-pending-${process.pid}`);
    expect((await supertest(onboardingApp).get("/api/onboarding/requests")).status).toBe(403);
    clerkState.userId = ""; clerkState.sessionClaims = {};
    expect((await supertest(adminApp).get("/api/admin/stats")).status).toBe(401);
  });

  it("allows the platform admin to read statistics, audit, and onboarding data", async () => {
    as("platform-owner-fixture");
    const stats = await supertest(adminApp).get("/api/admin/stats");
    expect(stats.status, JSON.stringify(stats.body)).toBe(200);
    const audit = await supertest(auditApp).get("/api/audit");
    expect(audit.status).toBe(200);
    expect(audit.body.entries.some((row: { action: string }) => row.action === "TENANT_B_SECRET")).toBe(true);
    const list = await supertest(onboardingApp).get("/api/onboarding/requests");
    expect(list.status).toBe(200);
    expect(list.body.requests.some((row: { id: number }) => row.id === onboardingId)).toBe(true);
    expect((await supertest(onboardingApp).get(`/api/onboarding/requests/${onboardingId}`)).status).toBe(200);
  });

  it("scopes tenant reports and CSV to authorized tenant A while global admin can view both tenants", async () => {
    as(`boundary-a-${process.pid}`);
    const report = await supertest(reportsApp).get("/api/admin/reports/summary");
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.totals).toMatchObject({ orderCount: 1, revenue: 15, activeShiftCount: 1 });
    expect(JSON.stringify(report.body)).not.toMatch(/Tenant B secret|900|private-b@/);
    const csv = await supertest(reportsApp).get("/api/admin/reports/export.csv");
    expect(csv.status).toBe(200);
    expect(csv.text).not.toMatch(/Tenant B secret|900|private-b@/);
    expect((await supertest(reportsApp).get("/api/admin/reports/summary?tenantId=" + tenantB)).status).toBe(403);

    as("platform-owner-fixture");
    const globalReport = await supertest(reportsApp).get("/api/admin/reports/summary");
    expect(globalReport.status).toBe(200);
    expect(globalReport.body.totals.orderCount).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(globalReport.body)).toContain("Tenant B secret");
  });

  it("keeps onboarding approval separate from account approval and audits tenant creation", async () => {
    as(`boundary-a-${process.pid}`);
    const denied = await supertest(onboardingApp).patch(`/api/onboarding/requests/${onboardingId}`).send({ status: "approved" });
    expect(denied.status).toBe(403);
    expect((await pool.query("SELECT status,tenant_id FROM public.onboarding_requests WHERE id=$1", [onboardingId])).rows[0]).toMatchObject({ status: "submitted", tenant_id: null });

    as("platform-owner-fixture", false);
    expect((await supertest(onboardingApp).patch(`/api/onboarding/requests/${onboardingId}`).send({ status: "approved" })).status).toBe(403);
    as("platform-owner-fixture");
    const changed = await supertest(onboardingApp).patch(`/api/onboarding/requests/${onboardingId}`).send({ status: "approved" });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.status).toBe("approved");
    expect((await pool.query("SELECT status,role,tenant_id,approved_by_clerk_id,approved_at FROM public.users WHERE id=$1", [userB])).rows[0]).toMatchObject({ status: "approved", role: "tenant_admin", tenant_id: tenantB });
    expect((await pool.query("SELECT status,tenant_id FROM public.users WHERE id=$1", [pendingUser])).rows[0]).toMatchObject({ status: "pending", tenant_id: null });
    expect((await pool.query("SELECT action,actor_id,tenant_id,metadata FROM public.audit_logs WHERE action='UPDATE_ONBOARDING_REQUEST' AND resource_id=$1", [String(onboardingId)])).rows[0]).toMatchObject({ action: "UPDATE_ONBOARDING_REQUEST", actor_id: globalUser, tenant_id: null, metadata: expect.objectContaining({ scope: "platform", newStatus: "approved" }) });
    const beforeCount = (await pool.query("SELECT count(*)::int AS count FROM public.tenants")).rows[0]!.count;
    const forged = await supertest(onboardingApp).patch(`/api/onboarding/requests/${onboardingId}`).send({ status: "approved", tenantId: tenantB, role: "global_admin", approvedByClerkId: "attacker", approvedAt: "now" });
    expect(forged.status).toBe(400);
    expect((await pool.query("SELECT count(*)::int AS count FROM public.tenants")).rows[0]!.count).toBe(beforeCount);
  });

  it("purges platform-wide records only for global admin and audits the scope", async () => {
    as("platform-owner-fixture", false);
    const recentDenied = await supertest(adminApp).post("/api/admin/purge").send({ confirm: "PURGE_ALL_SESSIONS" });
    expect(recentDenied.status).toBe(403);
    as("platform-owner-fixture");
    const result = await supertest(adminApp).post("/api/admin/purge").send({ confirm: "PURGE_ALL_SESSIONS" });
    expect(result.status).toBe(200);
    expect(result.body.ordersDeleted).toBe(2);
    expect(result.body.notificationsDeleted).toBe(2);
    expect((await pool.query("SELECT count(*)::int AS count FROM public.orders WHERE id=ANY($1::int[])", [[orderA, orderB]])).rows[0]!.count).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM public.notifications WHERE user_id=ANY($1::int[]) AND is_read=false", [[userA, userB]])).rows[0]!.count).toBe(0);
    expect((await pool.query("SELECT actor_id,actor_role,tenant_id,action,resource_output,resource_id,metadata FROM public.audit_logs WHERE actor_id=$1 AND action='EMERGENCY_PURGE' ORDER BY id DESC LIMIT 1", [globalUser])).rows[0]).toMatchObject({ actor_id: globalUser, actor_role: "global_admin", tenant_id: null, action: "EMERGENCY_PURGE", resource_output: "platform", resource_id: "all", metadata: expect.objectContaining({ scope: "platform", purgedOrderCount: 2, purgedNotificationCount: 2 }) });
  });
});
