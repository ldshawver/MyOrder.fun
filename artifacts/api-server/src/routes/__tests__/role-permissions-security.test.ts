import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

let mockActor: Record<string, unknown>;
const inserted: Array<Record<string, unknown>> = [];
const deleted: Array<unknown> = [];
const updated: Array<Record<string, unknown>> = [];

vi.mock("../../lib/auth", async () => {
  const roles = await import("../../lib/roles");
  return {
    normalizeRole: roles.normalizeRole,
    requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    loadDbUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as unknown as { dbUser: Record<string, unknown> }).dbUser = mockActor;
      next();
    },
    requireDbUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    requireApproved: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  };
});

const table = { tenantId: "tenantId", role: "role", permission: "permission", id: "id" };
vi.mock("@workspace/db", () => {
  const makeSelectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(async () => []);
    chain.then = (resolve: (value: unknown[]) => unknown) => resolve([]);
    return chain;
  };
  return {
    rolePermissionsTable: table,
    permissionAuditLogsTable: { ...table, actorUserId: "actorUserId", action: "action", targetRole: "targetRole", oldValue: "oldValue", newValue: "newValue" },
    usersTable: { role: "role", tenantId: "tenantId" },
    db: {
      select: vi.fn(() => makeSelectChain()),
      insert: vi.fn(() => ({ values: vi.fn((value: Record<string, unknown>) => { inserted.push(value); return Promise.resolve([]); }) })),
      update: vi.fn(() => ({ set: vi.fn((value: Record<string, unknown>) => ({ where: vi.fn(() => { updated.push(value); return Promise.resolve([]); }) })) })),
      delete: vi.fn(() => ({ where: vi.fn((where: unknown) => { deleted.push(where); return Promise.resolve([]); }) })),
    },
  };
});

async function buildApp() {
  const { default: router } = await import("../role-permissions");
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  vi.resetModules();
  inserted.length = 0;
  deleted.length = 0;
  updated.length = 0;
  mockActor = { id: 10, role: "admin", tenantId: 1, status: "approved", isActive: true, email: "admin@t1.test" };
});

describe("role permission security controls", () => {
  it("blocks tenant admins from cross-tenant permission modification", async () => {
    const app = await buildApp();
    const res = await supertest(app).put("/api/admin/roles-permissions/csr").send({ tenantId: 2, permissions: { "orders.update": true } });
    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it("blocks tenant admins from modifying global_admin permissions", async () => {
    const app = await buildApp();
    const res = await supertest(app).put("/api/admin/roles-permissions/global_admin").send({ permissions: { "users.manage_permissions": false } });
    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it("blocks tenant admins from granting platform permissions", async () => {
    const app = await buildApp();
    const res = await supertest(app).put("/api/admin/roles-permissions/csr").send({ permissions: { "platform.tenants.manage": true } });
    expect(res.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });


  it("allows tenant admins to persist disabled platform permissions without granting them", async () => {
    const app = await buildApp();
    const res = await supertest(app).put("/api/admin/roles-permissions/csr").send({ permissions: { "platform.tenants.manage": false } });
    expect(res.status).toBe(200);
    expect(inserted).toEqual(expect.arrayContaining([expect.objectContaining({ tenantId: 1, role: "csr", permission: "platform.tenants.manage", enabled: false })]));
  });

  it("rejects unknown permission keys with strict schema validation", async () => {
    const app = await buildApp();
    const res = await supertest(app).put("/api/admin/roles-permissions/csr").send({ permissions: { "platform.tenants.manage": true, "not.a.permission": true } });
    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it("prevents tenant lockout by rejecting disabled core admin permission management", async () => {
    const app = await buildApp();
    const res = await supertest(app).put("/api/admin/roles-permissions/admin").send({ permissions: { "users.manage_permissions": false } });
    expect(res.status).toBe(409);
    expect(inserted).toHaveLength(0);
  });

  it("allows global_admin to target another tenant explicitly", async () => {
    mockActor = { id: 99, role: "global_admin", tenantId: null, status: "approved", isActive: true, email: "root@test" };
    const app = await buildApp();
    const res = await supertest(app).put("/api/admin/roles-permissions/csr").send({ tenantId: 2, permissions: { "orders.update": true } });
    expect(res.status).toBe(200);
    expect(inserted).toEqual(expect.arrayContaining([expect.objectContaining({ tenantId: 2, role: "csr", permission: "orders.update", enabled: true })]));
  });
});
