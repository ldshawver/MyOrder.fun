/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

const fixture = vi.hoisted(() => ({
  actor: null as null | { id: number; clerkId: string; email: string; role: string; tenantId: number | null; status: string; approvedByClerkId?: string | null; approvedAt?: Date | null },
  authenticated: true,
  recent: true,
  tenants: [] as Array<Record<string, any>>,
  users: [] as Array<Record<string, any>>,
  orders: [] as Array<Record<string, any>>,
  items: [] as Array<Record<string, any>>,
  shifts: [] as Array<Record<string, any>>,
  onboarding: [] as Array<Record<string, any>>,
  audits: [] as Array<Record<string, any>>,
  insertCalls: [] as Array<{ table: string; row: Record<string, any> }>,
  updateCalls: [] as Array<{ table: string; row: Record<string, any> }>,
  selectCalls: [] as string[],
  failUserInsert: false,
}));

vi.mock("../../lib/profileImageStore", () => ({
  assertTemporaryProfileImage: vi.fn(async () => undefined),
  cleanupTemporaryProfileImages: vi.fn(async () => undefined),
  finalizeProfileImage: vi.fn(async () => undefined),
  readProfileImage: vi.fn(async () => Buffer.from("safe-image")),
  storeTemporaryProfileImage: vi.fn(async () => "f2862f21-4f21-48f2-8cad-79bde3f2c2c3"),
}));

vi.mock("../../lib/auth", () => {
  const pass = (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
  const role = (value: unknown) => value === "tenant_admin" ? "admin" : value;
  return {
    requireAuth: (_req: express.Request, res: express.Response, next: express.NextFunction) => fixture.authenticated ? next() : res.status(401).json({ error: "Authentication required" }),
    loadDbUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => { (req as express.Request & { dbUser?: unknown }).dbUser = fixture.actor; next(); },
    requireDbUser: pass,
    requireApproved: (_req: express.Request, res: express.Response, next: express.NextFunction) => fixture.actor?.status === "approved" ? next() : res.status(403).json({ error: "Account pending approval" }),
    requireRole: (...allowed: string[]) => (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      const current = role(fixture.actor?.role);
      return current && (allowed.includes(current) || (current === "global_admin" && allowed.includes("admin"))) ? next() : res.status(403).json({ error: "Forbidden" });
    },
    requireRecentOwnerAuth: (_req: express.Request, res: express.Response, next: express.NextFunction) => fixture.recent ? next() : res.status(403).json({ error: "Recent authentication required" }),
    writeAuditLog: vi.fn(async () => undefined),
  };
});

vi.mock("@workspace/db", () => {
  const col = (table: string, field: string) => `${table}.${field}`;
  const tenantsTable = { id: col("tenants", "id"), status: col("tenants", "status"), createdAt: col("tenants", "createdAt") };
  const usersTable = { id: col("users", "id"), clerkId: col("users", "clerkId"), tenantId: col("users", "tenantId"), status: col("users", "status"), role: col("users", "role"), email: col("users", "email") };
  const ordersTable = { id: col("orders", "id"), tenantId: col("orders", "tenantId"), createdAt: col("orders", "createdAt"), total: col("orders", "total"), paymentStatus: col("orders", "paymentStatus"), paymentMethod: col("orders", "paymentMethod"), assignedCsrUserId: col("orders", "assignedCsrUserId") };
  const orderItemsTable = { orderId: col("items", "orderId"), createdAt: col("items", "createdAt"), catalogItemName: col("items", "catalogItemName"), quantity: col("items", "quantity"), totalPrice: col("items", "totalPrice") };
  const labTechShiftsTable = { id: col("shifts", "id"), tenantId: col("shifts", "tenantId"), techId: col("shifts", "techId"), createdAt: col("shifts", "createdAt"), status: col("shifts", "status"), summary: col("shifts", "summary"), differenceAmount: col("shifts", "differenceAmount"), depositAmount: col("shifts", "depositAmount"), clockedInAt: col("shifts", "clockedInAt"), clockedOutAt: col("shifts", "clockedOutAt") };
  const onboardingRequestsTable = { id: col("onboarding", "id"), createdAt: col("onboarding", "createdAt"), status: col("onboarding", "status"), companyName: col("onboarding", "companyName"), contactEmail: col("onboarding", "contactEmail"), tenantId: col("onboarding", "tenantId") };
  const auditLogsTable = { id: col("audits", "id"), createdAt: col("audits", "createdAt") };
  const dataFor = (table: any) => table === tenantsTable ? fixture.tenants : table === usersTable ? fixture.users : table === ordersTable ? fixture.orders : table === orderItemsTable ? fixture.items : table === labTechShiftsTable ? fixture.shifts : table === onboardingRequestsTable ? fixture.onboarding : table === auditLogsTable ? fixture.audits : [];
  const nameFor = (table: any) => table === tenantsTable ? "tenants" : table === usersTable ? "users" : table === ordersTable ? "orders" : table === orderItemsTable ? "items" : table === labTechShiftsTable ? "shifts" : table === onboardingRequestsTable ? "onboarding" : table === auditLogsTable ? "audits" : "unknown";
  const match = (row: Record<string, any>, condition: any) => {
    if (!condition) return true;
    if (Array.isArray(condition)) return condition.every((item) => match(row, item));
    if (condition.op === "eq") return row[condition.field.split(".")[1]!] === condition.value;
    if (condition.op === "in") return condition.value.includes(row[condition.field.split(".")[1]!]);
    if (condition.op === "and") return condition.conditions.every((item: any) => match(row, item));
    return true;
  };
  const db: any = {
    execute: vi.fn(async () => []),
    select: (selection?: any) => {
      let table: any; let condition: any;
      const builder: any = {
        from(value: any) { table = value; fixture.selectCalls.push(nameFor(table)); return builder; },
        where(value: any) { condition = value; return builder; },
        orderBy() { return builder; },
        limit(value: number) { return Promise.resolve(result().slice(0, value)); },
        innerJoin() { return builder; },
        then(resolve: (rows: any[]) => unknown, reject: (error: unknown) => unknown) { return Promise.resolve(result()).then(resolve, reject); },
      };
      const result = () => {
        const rows = dataFor(table).filter((row: Record<string, any>) => match(row, condition));
        if (selection?.count) return [{ count: rows.length }];
        return rows;
      };
      return builder;
    },
    insert: (table: any) => ({ values: (row: Record<string, any>) => {
      const name = nameFor(table); fixture.insertCalls.push({ table: name, row });
      let inserted: Record<string, any>[];
      if (table === tenantsTable) { const tenant = { id: 30 + fixture.tenants.length, createdAt: new Date(), ...row }; fixture.tenants.push(tenant); inserted = [tenant]; }
      else if (table === auditLogsTable) { fixture.audits.push({ id: fixture.audits.length + 1, createdAt: new Date(), ...row }); inserted = [fixture.audits.at(-1)!]; }
      else if (table === onboardingRequestsTable) { const request = { id: 400 + fixture.onboarding.length, createdAt: new Date(), updatedAt: new Date(), ...row }; fixture.onboarding.push(request); inserted = [request]; }
      else if (table === usersTable) { if (fixture.failUserInsert) throw new Error("fixture provisioning failure"); const user = { id: 100 + fixture.users.length, ...row }; fixture.users.push(user); inserted = [user]; }
      else inserted = [row];
      return { returning: async () => inserted, then: (resolve: (rows: any[]) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(inserted).then(resolve, reject) };
    } }),
    update: (table: any) => ({ set: (row: Record<string, any>) => ({ where: (condition: any) => ({ returning: async () => {
      const name = nameFor(table); fixture.updateCalls.push({ table: name, row });
      const target = dataFor(table).find((item: Record<string, any>) => match(item, condition));
      if (!target) return [];
      Object.assign(target, row);
      return [target];
    } }) }) }),
    transaction: async (work: (tx: any) => Promise<any>) => {
      const snapshots = [fixture.users, fixture.onboarding, fixture.audits].map((rows) => structuredClone(rows));
      try { return await work(db); }
      catch (err) {
        [fixture.users, fixture.onboarding, fixture.audits].forEach((rows, index) => { rows.splice(0, rows.length, ...snapshots[index]!); });
        throw err;
      }
    },
  };
  return { db, tenantsTable, usersTable, ordersTable, orderItemsTable, labTechShiftsTable, onboardingRequestsTable, auditLogsTable };
});

vi.mock("drizzle-orm", () => ({
  eq: (field: string, value: unknown) => ({ op: "eq", field, value }),
  inArray: (field: string, value: unknown[]) => ({ op: "in", field, value }),
  and: (...conditions: unknown[]) => ({ op: "and", conditions }),
  count: () => ({ count: true }),
  desc: (field: unknown) => field,
  gte: (field: string, value: unknown) => ({ op: "gte", field, value }),
  lte: (field: string, value: unknown) => ({ op: "lte", field, value }),
  sql: Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }), { raw: (value: string) => ({ raw: value }) }),
}));

import adminRouter from "../admin";
import auditRouter from "../audit";
import onboardingRouter from "../onboarding";
import reportsRouter from "../reports";

const platformCases = [
  { name: "stats", method: "get", path: "/api/admin/stats" },
  { name: "audit", method: "get", path: "/api/audit" },
  { name: "onboarding list", method: "get", path: "/api/onboarding/requests" },
  { name: "onboarding detail", method: "get", path: "/api/onboarding/requests/202" },
  { name: "onboarding update", method: "patch", path: "/api/onboarding/requests/202", body: { status: "rejected", reviewNotes: "Denied fixture request" } },
] as const;

function app(router?: express.Router) {
  const server = express(); server.use(express.json());
  if (router) server.use("/api", router);
  server.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error instanceof Error ? error.message : String(error) }));
  return server;
}

function routeFor(item: typeof platformCases[number]) {
  return item.path.includes("onboarding") ? onboardingRouter : item.path === "/api/audit" ? auditRouter : adminRouter;
}

function request(server: express.Express, item: typeof platformCases[number]) {
  const call = (supertest(server) as any)[item.method](item.path);
  return "body" in item ? call.send(item.body) : call;
}

beforeEach(() => {
  fixture.actor = { id: 1, clerkId: "tenant-a-admin", email: "a-admin@test.invalid", role: "tenant_admin", tenantId: 1, status: "approved", approvedByClerkId: "owner", approvedAt: new Date("2026-01-01T00:00:00Z") };
  fixture.authenticated = true; fixture.recent = true;
  fixture.tenants = [{ id: 1, name: "Tenant A", slug: "tenant-a", status: "active", contactEmail: "a@test.invalid", createdAt: new Date() }, { id: 2, name: "Tenant B", slug: "tenant-b", status: "active", contactEmail: "b@test.invalid", createdAt: new Date() }];
  fixture.users = [
    { id: 1, clerkId: "tenant-a-admin", email: "a-admin@test.invalid", firstName: "Tenant", lastName: "A", role: "tenant_admin", tenantId: 1, status: "approved" },
    { id: 2, clerkId: "applicant-b", email: "contact-b@private.invalid", firstName: "Applicant", lastName: "B", role: "user", tenantId: null, status: "pending", approvedByClerkId: null, approvedAt: null },
  ];
  fixture.orders = [
    { id: 101, tenantId: 1, createdAt: new Date("2026-03-01T00:00:00Z"), total: "15.00", paymentStatus: "paid", paymentMethod: "cash", assignedCsrUserId: 1 },
    { id: 201, tenantId: 2, createdAt: new Date("2026-03-01T00:00:00Z"), total: "900.00", paymentStatus: "paid", paymentMethod: "paypal", assignedCsrUserId: 2 },
  ];
  fixture.items = [
    { orderId: 101, createdAt: new Date(), catalogItemName: "A item", quantity: 1, totalPrice: "15.00" },
    { orderId: 201, createdAt: new Date(), catalogItemName: "B confidential item", quantity: 1, totalPrice: "900.00" },
  ];
  fixture.shifts = [
    { id: 11, tenantId: 1, techId: 1, createdAt: new Date(), status: "active", summary: { totalRevenue: 15, orderCount: 1 }, differenceAmount: "0", depositAmount: "0" },
    { id: 22, tenantId: 2, techId: 2, createdAt: new Date(), status: "active", summary: { totalRevenue: 900, orderCount: 1 }, differenceAmount: "90", depositAmount: "900" },
  ];
  fixture.onboarding = [{ id: 202, companyName: "Tenant B Confidential LLC", contactName: "B Contact", contactEmail: "contact-b@private.invalid", businessType: "retail", status: "submitted", tenantId: null, createdAt: new Date(), updatedAt: new Date() }];
  fixture.audits = [{ id: 1, createdAt: new Date(), tenantId: 2, actorId: 2, actorEmail: "b-person@private.invalid", actorRole: "admin", action: "tenant-b-private-action", resourceType: "order", resourceId: "201", metadata: { privateMarker: "TENANT_B_SECRET" }, ipAddress: "203.0.113.20" }];
  fixture.insertCalls = []; fixture.updateCalls = []; fixture.selectCalls = [];
  fixture.failUserInsert = false;
});

describe("platform-only authorization boundary", () => {
  it.each(platformCases)("denies tenant_admin on $name without querying or mutating platform data", async (item) => {
    const before = JSON.stringify({ tenants: fixture.tenants, users: fixture.users, onboarding: fixture.onboarding, audits: fixture.audits });
    const response = await request(app(routeFor(item)), item);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toMatch(/Tenant B Confidential|contact-b@|TENANT_B_SECRET|203\.0\.113\.20/);
    expect(JSON.stringify({ tenants: fixture.tenants, users: fixture.users, onboarding: fixture.onboarding, audits: fixture.audits })).toBe(before);
  });

  it.each(platformCases)("allows global_admin on $name", async (item) => {
    fixture.actor = { id: 99, clerkId: "platform-admin", email: "platform@test.invalid", role: "global_admin", tenantId: null, status: "approved", approvedByClerkId: "owner", approvedAt: new Date() };
    const response = await request(app(routeFor(item)), item);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it.each(platformCases)("denies ordinary users on $name", async (item) => {
    fixture.actor = { id: 4, clerkId: "ordinary", email: "user@test.invalid", role: "user", tenantId: 1, status: "approved" };
    expect((await request(app(routeFor(item)), item)).status).toBe(403);
  });

  it.each(platformCases)("denies unapproved users on $name", async (item) => {
    fixture.actor = { id: 4, clerkId: "pending", email: "pending@test.invalid", role: "global_admin", tenantId: null, status: "pending" };
    expect((await request(app(routeFor(item)), item)).status).toBe(403);
  });

  it.each(platformCases)("denies unauthenticated requests to $name", async (item) => {
    fixture.authenticated = false;
    expect((await request(app(routeFor(item)), item)).status).toBe(401);
  });
});

describe("tenant report isolation", () => {
  it("returns only tenant A financial, item, shift, and user-derived report data", async () => {
    const response = await supertest(app(reportsRouter)).get("/api/admin/reports/summary");
    expect(response.status).toBe(200);
    expect(response.body.totals).toMatchObject({ orderCount: 1, paidOrderCount: 1, revenue: 15, activeShiftCount: 1, discrepancyTotal: 0 });
    expect(JSON.stringify(response.body)).not.toMatch(/B confidential|900|contact-b@|TENANT_B_SECRET/);
    expect(fixture.selectCalls.filter((table) => ["orders", "items", "shifts", "users"].includes(table))).toEqual(expect.arrayContaining(["orders", "items", "shifts", "users"]));

    const csv = await supertest(app(reportsRouter)).get("/api/admin/reports/export.csv");
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("15");
    expect(csv.text).not.toMatch(/900|B confidential|contact-b@/);
  });

  it("rejects client-selected foreign tenant context", async () => {
    const response = await supertest(app(reportsRouter)).get("/api/admin/reports/export.csv?tenantId=2");
    expect(response.status).toBe(403);
    expect(response.text).not.toContain("900.00");
  });

  it("keeps platform-wide reporting available to global_admin", async () => {
    fixture.actor = { id: 99, clerkId: "platform-admin", email: "platform@test.invalid", role: "global_admin", tenantId: null, status: "approved" };
    const response = await supertest(app(reportsRouter)).get("/api/admin/reports/summary");
    expect(response.status).toBe(200);
    expect(response.body.totals).toMatchObject({ orderCount: 2, revenue: 915, activeShiftCount: 2, discrepancyTotal: 90 });
    expect(JSON.stringify(response.body)).toContain("B confidential item");
  });
});

describe("onboarding tenant approval stays separate from account approval", () => {
  it("does not mutate user role/status/provenance when global admin approves a tenant request", async () => {
    fixture.actor = { id: 99, clerkId: "platform-admin", email: "platform@test.invalid", role: "global_admin", tenantId: null, status: "approved", approvedByClerkId: "owner", approvedAt: new Date() };
    const userBefore = structuredClone(fixture.users[1]);
    const response = await supertest(app(onboardingRouter)).patch("/api/onboarding/requests/202").send({ status: "approved" });
    expect(response.status).toBe(200);
    expect(fixture.users[1]).toEqual(userBefore);
    expect(fixture.updateCalls.map((call) => call.table)).toEqual(["onboarding"]);
    expect(fixture.insertCalls.map((call) => call.table)).toEqual(expect.arrayContaining(["tenants", "audits"]));
    expect(fixture.audits.at(-1)).toMatchObject({ actorId: 99, tenantId: null, action: "UPDATE_ONBOARDING_REQUEST", metadata: { scope: "platform", newStatus: "approved", createdTenantId: expect.any(Number) } });
  });

  it("rejects client-supplied tenant, role, status, and provenance fields", async () => {
    fixture.actor = { id: 99, clerkId: "platform-admin", email: "platform@test.invalid", role: "global_admin", tenantId: null, status: "approved", approvedByClerkId: "owner", approvedAt: new Date() };
    const response = await supertest(app(onboardingRouter)).patch("/api/onboarding/requests/202").send({ status: "approved", tenantId: 2, role: "global_admin", approvedByClerkId: "attacker", approvedAt: "now" });
    expect(response.status).toBe(400);
    expect(fixture.insertCalls).toHaveLength(0);
    expect(fixture.updateCalls).toHaveLength(0);
  });

  it("requires recent authentication for onboarding approval and creates no tenant when stale", async () => {
    fixture.actor = { id: 99, clerkId: "platform-admin", email: "platform@test.invalid", role: "global_admin", tenantId: null, status: "approved" };
    fixture.recent = false;
    const response = await supertest(app(onboardingRouter)).patch("/api/onboarding/requests/202").send({ status: "approved" });
    expect(response.status).toBe(403);
    expect(fixture.tenants).toHaveLength(2);
    expect(fixture.updateCalls).toHaveLength(0);
  });
});

describe("verified member registration provisioning", () => {
  const email = "new-member@test.invalid";
  const body = {
    companyName: "Individual", contactName: "New Member", contactEmail: email,
    businessType: "customer", profileImageUploadId: "f2862f21-4f21-48f2-8cad-79bde3f2c2c3",
  };

  beforeEach(() => {
    fixture.actor = { id: 50, clerkId: "clerk-new-member", email, role: "user", tenantId: null, status: "pending" };
    fixture.users = [];
    fixture.onboarding = [];
  });

  it("creates the pending user and access request on first verified submission", async () => {
    const response = await supertest(app(onboardingRouter)).post("/api/onboarding/request").send(body);
    expect(response.status).toBe(200);
    expect(fixture.onboarding).toHaveLength(1);
    expect(fixture.users).toHaveLength(1);
    expect(fixture.users[0]).toMatchObject({ email, role: "user", status: "pending", avatarUrl: `/api/profile-images/${body.profileImageUploadId}` });
  });

  it("treats repeated submissions as idempotent and creates no duplicate account", async () => {
    const server = app(onboardingRouter);
    const first = await supertest(server).post("/api/onboarding/request").send(body);
    const second = await supertest(server).post("/api/onboarding/request").send(body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(fixture.onboarding).toHaveLength(1);
    expect(fixture.users).toHaveLength(1);
  });

  it("rolls back interrupted provisioning and recovers on retry", async () => {
    fixture.failUserInsert = true;
    const server = app(onboardingRouter);
    expect((await supertest(server).post("/api/onboarding/request").send(body)).status).toBe(500);
    expect(fixture.onboarding).toHaveLength(0);
    expect(fixture.users).toHaveLength(0);
    fixture.failUserInsert = false;
    expect((await supertest(server).post("/api/onboarding/request").send(body)).status).toBe(200);
    expect(fixture.onboarding).toHaveLength(1);
    expect(fixture.users).toHaveLength(1);
  });

  it("does not provision an unauthenticated or different-email identity", async () => {
    fixture.actor = { id: 51, clerkId: "another-member", email: "different@test.invalid", role: "user", tenantId: null, status: "pending" };
    expect((await supertest(app(onboardingRouter)).post("/api/onboarding/request").send(body)).status).toBe(403);
    fixture.authenticated = false;
    expect((await supertest(app(onboardingRouter)).post("/api/onboarding/request").send(body)).status).toBe(401);
    expect(fixture.onboarding).toHaveLength(0);
    expect(fixture.users).toHaveLength(0);
  });
});
