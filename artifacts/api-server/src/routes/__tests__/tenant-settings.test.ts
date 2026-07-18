import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";

let actor: { id: number; email: string; role: string; tenantId?: number | null; status?: string; isActive?: boolean } | null = { id: 1, email: "admin@a.test", role: "admin", tenantId: 1 };
let permissionAllowed = true;
const audits: unknown[] = [];
const updateCalls: unknown[] = [];
let currentSettings: Record<number, { business: Record<string, unknown> }> = {};
let updateResult: { updated: unknown; stale: boolean; missing: boolean } = { updated: null, stale: false, missing: false };
const originalNodeEnv = process.env.NODE_ENV;

vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: express.Request, res: express.Response, next: express.NextFunction) => actor ? next() : res.status(401).json({ error: "Unauthorized" }),
  loadDbUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => { if (actor) req.dbUser = actor as never; next(); },
  requireDbUser: (req: express.Request, res: express.Response, next: express.NextFunction) => req.dbUser ? next() : res.status(401).json({ error: "User profile not found" }),
  requireApproved: (req: express.Request, res: express.Response, next: express.NextFunction) => req.dbUser?.status === "pending" ? res.status(403).json({ error: "Account pending approval" }) : next(),
  writeAuditLog: vi.fn(async (entry: unknown) => { audits.push(entry); }),
}));

vi.mock("../../lib/roles", () => ({
  hasPermission: vi.fn(async () => permissionAllowed),
}));

vi.mock("../../config/tenantConfig", () => ({
  getTenantSettings: vi.fn(async (tenantId: number) => currentSettings[tenantId] ?? null),
  updateTenantBusinessSettings: vi.fn(async (input: unknown) => { updateCalls.push(input); return updateResult; }),
}));

async function buildApp() {
  const router = (await import("../tenant-settings")).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.id = "req_test_1"; next(); });
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  process.env.NODE_ENV = "production";
  actor = { id: 1, email: "admin@a.test", role: "admin", tenantId: 1 };
  permissionAllowed = true;
  audits.length = 0;
  updateCalls.length = 0;
  currentSettings = {
    1: { business: { version: 1, publicBusinessName: "Tenant A", appName: "Tenant A", timezone: "America/Los_Angeles", defaultCurrency: "USD" } },
    2: { business: { version: 1, publicBusinessName: "Tenant B", appName: "Tenant B", timezone: "America/Los_Angeles", defaultCurrency: "USD" } },
  };
  updateResult = { updated: currentSettings[1], stale: false, missing: false };
});

describe("tenant settings API", () => {
  it("denies unauthenticated GET and PATCH without writing audit events", async () => {
    actor = null;
    const app = await buildApp();
    expect((await supertest(app).get("/api/settings")).status).toBe(401);
    expect((await supertest(app).patch("/api/settings/business").send({ version: 1, publicBusinessName: "Denied" })).status).toBe(401);
    expect(audits).toHaveLength(0);
  });

  it("denies unapproved users without writing audit events", async () => {
    actor = { id: 3, email: "pending@test", role: "admin", tenantId: 1, status: "pending" };
    const res = await supertest(await buildApp()).patch("/api/settings/business").send({ version: 1, publicBusinessName: "Denied" });
    expect(res.status).toBe(403);
    expect(updateCalls).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("returns only the authenticated tenant settings", async () => {
    const res = await supertest(await buildApp()).get("/api/settings");
    expect(res.status).toBe(200);
    expect(res.body.business.publicBusinessName).toBe("Tenant A");
    expect(JSON.stringify(res.body)).not.toContain("Tenant B");
  });

  it("rejects client-supplied tenantId as an unknown root field", async () => {
    const res = await supertest(await buildApp()).patch("/api/settings/business").send({ version: 1, tenantId: 2, publicBusinessName: "Hacked" });
    expect(res.status).toBe(400);
    expect(updateCalls).toHaveLength(0);
  });

  it("rejects guessed settings row IDs and spoofed roles or permissions as unknown root fields", async () => {
    for (const body of [
      { version: 1, id: 2, publicBusinessName: "Hacked" },
      { version: 1, role: "global_admin", publicBusinessName: "Hacked" },
      { version: 1, permissions: ["settings.edit_business"], publicBusinessName: "Hacked" },
    ]) {
      const res = await supertest(await buildApp()).patch("/api/settings/business").send(body);
      expect(res.status).toBe(400);
    }
    expect(updateCalls).toHaveLength(0);
  });

  it("fails safely when the actor has no tenant context", async () => {
    actor = { id: 2, email: "global@test", role: "global_admin", tenantId: null };
    const res = await supertest(await buildApp()).patch("/api/settings/business").send({ version: 1, publicBusinessName: "No tenant" });
    expect(res.status).toBe(403);
    expect(updateCalls).toHaveLength(0);
  });

  it("denies edits when permission is missing", async () => {
    permissionAllowed = false;
    const res = await supertest(await buildApp()).patch("/api/settings/business").send({ version: 1, publicBusinessName: "Denied" });
    expect(res.status).toBe(403);
    expect(audits).toHaveLength(0);
  });

  it("rejects route-level validation abuse cases before update", async () => {
    for (const body of [
      { version: 1, websiteUrl: "javascript:alert(1)" },
      { version: 1, websiteUrl: "file:///etc/passwd" },
      { version: 1, websiteUrl: "ftp://example.com" },
      { version: 1, websiteUrl: "https://bad_host.example" },
      { version: 1, websiteUrl: "https://user:password@example.com" },
      { version: 1, supportEmail: "not-email" },
      { version: 1, timezone: "Fake/Zone" },
      { version: 1, defaultCurrency: "EUR" },
      { version: 1, publicBusinessName: "x".repeat(121) },
      { version: 1, businessDescription: "x".repeat(2001) },
      { version: 1, supportPhone: "555\u0001" },
      { version: 1, businessAddress: { line1: "1 Main", tenantId: 2 } },
    ]) {
      const res = await supertest(await buildApp()).patch("/api/settings/business").send(body);
      expect(res.status).toBe(400);
    }
    expect(updateCalls).toHaveLength(0);
  });

  it("allows development-only localhost URLs deterministically", async () => {
    process.env.NODE_ENV = "development";
    updateResult = { updated: { business: { ...currentSettings[1].business, version: 2, websiteUrl: "http://localhost:3000" } }, stale: false, missing: false };
    const res = await supertest(await buildApp()).patch("/api/settings/business").send({ version: 1, websiteUrl: "http://localhost:3000" });
    expect(res.status).toBe(200);
  });

  it("returns 409 for stale versions", async () => {
    updateResult = { updated: null, stale: true, missing: false };
    currentSettings[1].business.version = 3;
    const res = await supertest(await buildApp()).patch("/api/settings/business").send({ version: 1, publicBusinessName: "Stale" });
    expect(res.status).toBe(409);
    expect(res.body.currentVersion).toBe(3);
    expect(audits).toHaveLength(0);
  });

  it("updates with trusted tenant and writes redacted audit metadata", async () => {
    updateResult = { updated: { business: { ...currentSettings[1].business, version: 2, publicBusinessName: "New A" } }, stale: false, missing: false };
    const res = await supertest(await buildApp()).patch("/api/settings/business").send({ version: 1, publicBusinessName: "New A", businessDescription: "Private description" });
    expect(res.status).toBe(200);
    expect(updateCalls[0]).toMatchObject({ tenantId: 1, actorUserId: 1 });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "tenant_settings.business_updated", tenantId: 1 });
    expect(JSON.stringify(audits[0])).toContain("changedFields");
    expect(JSON.stringify(audits[0])).not.toContain("Private description");
    expect(JSON.stringify(audits[0])).not.toContain("ipAddress");
    expect(JSON.stringify(audits[0])).not.toContain("::ffff");
  });
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});
