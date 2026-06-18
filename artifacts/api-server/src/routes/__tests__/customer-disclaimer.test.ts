import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";

type Actor = { id: number; role: string; email: string; tenantId?: number | null };
let mockActor: Actor = { id: 10, role: "user", email: "u@x", tenantId: 1 };
const settingsRows: Record<string, unknown>[] = [{
  id: 1,
  tenantId: 1,
  customerDisclaimerText: "Initial customer disclaimer copy that is long enough.",
  customerDisclaimerVersion: 1,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
}];
const acceptances: Record<string, unknown>[] = [];
const auditRows: Record<string, unknown>[] = [];

vi.mock("../../lib/auth", () => ({
  requireAuth: (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
  loadDbUser: (q: express.Request, _s: express.Response, n: express.NextFunction) => { (q as unknown as { dbUser: Actor }).dbUser = mockActor; n(); },
  requireDbUser: (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
  requireApproved: (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
  requireRole: (...roles: string[]) => (q: express.Request, s: express.Response, n: express.NextFunction) => {
    const role = (q as unknown as { dbUser?: Actor }).dbUser?.role;
    if (!role || !roles.includes(role)) return void s.status(403).json({ error: "Forbidden" });
    n();
  },
  writeAuditLog: vi.fn(async (row: Record<string, unknown>) => { auditRows.push(row); }),
}));
vi.mock("../../lib/singleTenant", () => ({ getHouseTenantId: async () => 1 }));
vi.mock("../../lib/crypto", () => ({ encrypt: (v: string) => v, safeDecrypt: (v: string | null) => v }));

const adminSettingsTable = { __t: "settings", id: "id", tenantId: "tenantId" };
const customerDisclaimerAcceptancesTable = { __t: "acceptances", tenantId: "tenantId", userId: "userId", disclaimerVersion: "disclaimerVersion" };

function selectRows(table: { __t?: string } | undefined) {
  if (table?.__t === "acceptances") return acceptances;
  return settingsRows;
}

vi.mock("@workspace/db", () => ({
  adminSettingsTable,
  customerDisclaimerAcceptancesTable,
  db: {
    execute: vi.fn(() => Promise.resolve()),
    select: () => ({
      from: (table: { __t?: string }) => ({
        where: (predicate: unknown) => ({ limit: async () => selectRows(table).filter((row) => (predicate as (r: Record<string, unknown>) => boolean)(row)).slice(0, 1) }),
        limit: async () => selectRows(table).slice(0, 1),
      }),
    }),
    insert: (table: { __t?: string }) => ({
      values: (vals: Record<string, unknown>) => ({
        returning: async () => {
          const row = { id: table.__t === "acceptances" ? acceptances.length + 1 : settingsRows.length + 1, acceptedAt: new Date("2026-01-02T00:00:00Z"), ...vals };
          if (table.__t === "acceptances") acceptances.push(row); else settingsRows.push(row);
          return [row];
        },
      }),
    }),
    update: () => ({ set: (vals: Record<string, unknown>) => ({ where: (predicate: unknown) => ({ returning: async () => {
      const row = settingsRows.find((r) => (predicate as (r: Record<string, unknown>) => boolean)(r)) ?? settingsRows[0]!;
      Object.assign(row, vals);
      return [row];
    } }) }) }),
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: unknown) => (row: Record<string, unknown>) => row[col] === val,
  and: (...preds: Array<(row: Record<string, unknown>) => boolean>) => (row: Record<string, unknown>) => preds.every((p) => p(row)),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
}));

async function buildApp() {
  vi.resetModules();
  const settingsRouter = (await import("../settings")).default;
  const app = express();
  app.use(express.json());
  app.use("/api", settingsRouter);
  return app;
}

beforeEach(() => {
  mockActor = { id: 10, role: "user", email: "u@x", tenantId: 1 };
  settingsRows.splice(0, settingsRows.length, { id: 1, tenantId: 1, customerDisclaimerText: "Initial customer disclaimer copy that is long enough.", customerDisclaimerVersion: 1, updatedAt: new Date("2026-01-01T00:00:00Z") });
  acceptances.length = 0;
  auditRows.length = 0;
});

describe("customer disclaimer", () => {
  it("new customer sees required disclaimer", async () => {
    const res = await supertest(await buildApp()).get("/api/customer/disclaimer");
    expect(res.status).toBe(200);
    expect(res.body.required).toBe(true);
    expect(res.body.version).toBe(1);
  });

  it("stores acceptance for current user, tenant, and version", async () => {
    const res = await supertest(await buildApp()).post("/api/customer/disclaimer/accept").send({ version: 1 });
    expect(res.status).toBe(201);
    expect(acceptances[0]).toMatchObject({ tenantId: 1, userId: 10, disclaimerVersion: 1 });
  });

  it("accepted user does not see same version again", async () => {
    acceptances.push({ id: 1, tenantId: 1, userId: 10, disclaimerVersion: 1, acceptedAt: new Date() });
    const res = await supertest(await buildApp()).get("/api/customer/disclaimer");
    expect(res.body.required).toBe(false);
  });

  it("version update requires reacceptance", async () => {
    acceptances.push({ id: 1, tenantId: 1, userId: 10, disclaimerVersion: 1, acceptedAt: new Date() });
    settingsRows[0]!.customerDisclaimerVersion = 2;
    const res = await supertest(await buildApp()).get("/api/customer/disclaimer");
    expect(res.body.required).toBe(true);
    expect(res.body.version).toBe(2);
  });

  it("denies unauthorized disclaimer edit", async () => {
    const res = await supertest(await buildApp()).put("/api/admin/settings/customer-disclaimer").send({ text: "Updated customer disclaimer copy that is long enough." });
    expect(res.status).toBe(403);
  });

  it("supervisor edit increments version and writes audit", async () => {
    mockActor = { id: 20, role: "supervisor", email: "s@x", tenantId: 1 };
    const res = await supertest(await buildApp()).put("/api/admin/settings/customer-disclaimer").send({ text: "Updated customer disclaimer copy that is long enough." });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(auditRows[0]).toMatchObject({ action: "settings.customer_disclaimer.updated", tenantId: 1 });
  });

  it("cross-tenant disclaimer access denied", async () => {
    mockActor = { id: 10, role: "user", email: "u@x", tenantId: 2 };
    const res = await supertest(await buildApp()).get("/api/customer/disclaimer");
    expect(res.status).toBe(403);
  });

  it("unknown fields rejected", async () => {
    const res = await supertest(await buildApp()).post("/api/customer/disclaimer/accept").send({ version: 1, userId: 99 });
    expect(res.status).toBe(400);
  });
});
