import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";

let mockActor: { id: number; role: string; email: string } = { id: 1, role: "admin", email: "a@x" };
const settingsRow: Record<string, unknown> = {
  id: 1, tenantId: 1, orderRoutingRule: "round_robin", defaultEtaMinutes: 30,
};

vi.mock("../../lib/auth", () => ({
  requireAuth: (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
  loadDbUser: (q: express.Request, _s: express.Response, n: express.NextFunction) => {
    (q as unknown as { dbUser: typeof mockActor }).dbUser = mockActor; n();
  },
  requireDbUser: (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
  requireApproved: (_q: express.Request, _s: express.Response, n: express.NextFunction) => n(),
  requireRole: (...roles: string[]) => (q: express.Request, s: express.Response, n: express.NextFunction) => {
    const u = (q as unknown as { dbUser?: { role: string } }).dbUser;
    if (!u || !roles.includes(u.role)) { s.status(403).json({ error: "Forbidden" }); return; }
    n();
  },
  writeAuditLog: vi.fn(async () => {}),
}));
vi.mock("../../lib/singleTenant", () => ({ getHouseTenantId: async () => 1 }));
vi.mock("../../lib/crypto", () => ({ encrypt: (v: string) => v, safeDecrypt: (v: string | null) => v }));
vi.mock("@workspace/db", () => {
  const adminSettingsTable = { id: { name: "id" } } as unknown;
  return {
    db: {
      select: () => ({ from: () => ({ limit: async () => [settingsRow] }) }),
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => { Object.assign(settingsRow, vals); return [settingsRow]; },
          }),
        }),
      }),
      insert: () => ({ values: () => ({ returning: async () => [settingsRow] }) }),
    },
    adminSettingsTable,
  };
});

async function buildApp() {
  const settingsRouter = (await import("../settings")).default;
  const app = express();
  app.use(express.json());
  app.use("/api", settingsRouter);
  return app;
}

beforeEach(() => {
  settingsRow.orderRoutingRule = "round_robin";
  settingsRow.defaultEtaMinutes = 30;
  mockActor = { id: 1, role: "admin", email: "a@x" };
});

describe("/admin/settings — routing rule contract", () => {
  it("GET returns orderRoutingRule and defaultEtaMinutes", async () => {
    const res = await supertest(await buildApp()).get("/api/admin/settings");
    expect(res.status).toBe(200);
    expect(res.body.orderRoutingRule).toBe("round_robin");
    expect(res.body.defaultEtaMinutes).toBe(30);
  });

  it("PUT persists a new routing rule + ETA", async () => {
    const res = await supertest(await buildApp())
      .put("/api/admin/settings")
      .send({ orderRoutingRule: "least_recent_order", defaultEtaMinutes: 45 });
    expect(res.status).toBe(200);
    expect(res.body.orderRoutingRule).toBe("least_recent_order");
    expect(res.body.defaultEtaMinutes).toBe(45);
  });

  it("PUT rejects an unknown routing rule with 400", async () => {
    const res = await supertest(await buildApp())
      .put("/api/admin/settings")
      .send({ orderRoutingRule: "bogus" });
    expect(res.status).toBe(400);
  });

  it("PUT rejects defaultEtaMinutes < 1", async () => {
    const res = await supertest(await buildApp())
      .put("/api/admin/settings")
      .send({ defaultEtaMinutes: 0 });
    expect(res.status).toBe(400);
  });

  it("non-supervisors cannot read or write", async () => {
    mockActor = { id: 2, role: "customer_service_rep", email: "c@x" };
    const r1 = await supertest(await buildApp()).get("/api/admin/settings");
    const r2 = await supertest(await buildApp()).put("/api/admin/settings").send({ orderRoutingRule: "round_robin" });
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
  });
});
