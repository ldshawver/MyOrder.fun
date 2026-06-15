import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

let mockActor: Record<string, unknown> = { id: 1, role: "admin", tenantId: 1, status: "approved", isActive: true };
const tenants = [{ id: 1, name: "One", slug: "one", status: "active", plan: "pro", contactEmail: "one@test", settings: {}, createdAt: new Date(), updatedAt: new Date() }];

vi.mock("../../lib/auth", async () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  loadDbUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => { (req as unknown as { dbUser: Record<string, unknown> }).dbUser = mockActor; next(); },
  requireDbUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireApproved: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  writeAuditLog: vi.fn(async () => {}),
}));

vi.mock("@workspace/db", () => {
  const tenantsTable = { id: "id", createdAt: "createdAt" };
  const mkSelect = (rows: unknown[]) => ({
    from: () => ({
      orderBy: async () => rows,
      where: () => ({ limit: async () => rows }),
      innerJoin: () => [],
      then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
    }),
  });
  return {
    tenantsTable,
    ordersTable: {},
    catalogItemsTable: {},
    usersTable: {},
    orderItemsTable: {},
    db: {
      select: vi.fn(() => mkSelect(tenants)),
      update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: async () => tenants }) }) })),
    },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
  count: vi.fn(() => "count"),
  desc: vi.fn((col) => col),
}));

async function buildApp() {
  const { default: router } = await import("../tenants");
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  vi.resetModules();
  mockActor = { id: 1, role: "admin", tenantId: 1, status: "approved", isActive: true };
});

describe("tenant management permission gates", () => {
  it("blocks tenant admins from global tenant listing", async () => {
    const res = await supertest(await buildApp()).get("/api/tenants");
    expect(res.status).toBe(403);
  });

  it("allows global_admin to access global tenant listing", async () => {
    mockActor = { id: 99, role: "global_admin", tenantId: null, status: "approved", isActive: true };
    const res = await supertest(await buildApp()).get("/api/tenants");
    expect(res.status).toBe(200);
  });
});
