import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";

let actor = { id: 1, email: "admin@example.com", role: "admin", tenantId: 10, status: "approved", isActive: true };
const executedSql: unknown[] = [];
const auditRows: unknown[] = [];

vi.mock("@workspace/db", () => {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => []),
    then: (resolve: (value: unknown[]) => unknown) => resolve([]),
  };
  const deleteChain = { where: vi.fn(async () => undefined) };
  return {
    db: {
      execute: vi.fn(async (statement: unknown) => { executedSql.push(statement); }),
      select: vi.fn(() => chain),
      insert: vi.fn(() => ({ values: vi.fn(async (row: unknown) => { auditRows.push(row); }) })),
      delete: vi.fn(() => deleteChain),
    },
    rolePermissionsTable: { tenantId: "tenantId", role: "role", permission: "permission" },
    permissionAuditLogsTable: {},
  };
});

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args) => args),
  eq: vi.fn((col, val) => ({ col, val })),
  isNull: vi.fn((col) => ({ isNull: col })),
  or: vi.fn((...args) => args),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
}));

vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  loadDbUser: (req: express.Request, _res: express.Response, next: express.NextFunction) => { req.dbUser = actor as never; next(); },
  requireDbUser: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireApproved: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireRole: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

import permissionsRouter from "../permissions";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", permissionsRouter);
  return app;
}

beforeEach(() => {
  actor = { id: 1, email: "admin@example.com", role: "admin", tenantId: 10, status: "approved", isActive: true };
  executedSql.length = 0;
  auditRows.length = 0;
});

describe("role permissions API", () => {
  it("admin cannot edit global_admin permissions", async () => {
    const res = await supertest(buildApp())
      .put("/api/admin/roles-permissions/global_admin")
      .send({ permissions: [{ permission: "users.manage_permissions", enabled: true }] });
    expect(res.status).toBe(403);
    expect(executedSql).toHaveLength(3); // schema ensure only
  });

  it("tenant admin cannot edit platform permissions", async () => {
    const res = await supertest(buildApp())
      .put("/api/admin/roles-permissions/csr")
      .send({ permissions: [{ permission: "platform.tenants.manage", enabled: true }] });
    expect(res.status).toBe(403);
    expect(auditRows).toHaveLength(0);
  });

  it("tenant admin can edit tenant-scoped role permissions in their own tenant", async () => {
    const res = await supertest(buildApp())
      .put("/api/admin/roles-permissions/csr")
      .send({ permissions: [{ permission: "orders.update", enabled: true }] });
    expect(res.status).toBe(200);
    expect(auditRows).toContainEqual(expect.objectContaining({ tenantId: 10, targetRole: "csr", permission: "orders.update" }));
  });

  it("global_admin can edit global_admin platform permissions", async () => {
    actor = { ...actor, role: "global_admin", tenantId: null } as typeof actor;
    const res = await supertest(buildApp())
      .put("/api/admin/roles-permissions/global_admin")
      .send({ permissions: [{ permission: "platform.tenants.manage", enabled: true }] });
    expect(res.status).toBe(200);
    expect(auditRows).toContainEqual(expect.objectContaining({ tenantId: null, targetRole: "global_admin", permission: "platform.tenants.manage" }));
  });
});
