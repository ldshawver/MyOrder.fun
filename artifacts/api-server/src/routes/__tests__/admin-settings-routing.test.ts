import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";

let mockActor: { id: number; role: string; email: string; tenantId?: number } = { id: 1, role: "admin", email: "a@x", tenantId: 1 };
const settingsRows: Record<number, Record<string, unknown>> = {
  1: { id: 1, tenantId: 1, orderRoutingRule: "round_robin", defaultEtaMinutes: 30 },
  2: { id: 2, tenantId: 2, orderRoutingRule: "round_robin", defaultEtaMinutes: 30 },
};
let activeTenantId = 1;
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
  const adminSettingsTable = { id: { name: "id" }, tenantId: { name: "tenantId" } } as unknown;
  return {
    db: {
      execute: vi.fn(() => Promise.resolve()),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [settingsRows[activeTenantId]] }), limit: async () => [settingsRows[activeTenantId]] }) }),
      update: () => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => { Object.assign(settingsRows[activeTenantId], vals); return [settingsRows[activeTenantId]]; },
          }),
        }),
      }),
      insert: () => ({ values: (vals: Record<string, unknown>) => ({ returning: async () => { const tenantId = Number(vals.tenantId); settingsRows[tenantId] = { id: tenantId, tenantId, ...vals }; return [settingsRows[tenantId]]; } }) }),
    },
    adminSettingsTable,
  };
});

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => ({ conditions })),
  eq: vi.fn((col, val) => { if ((col as { name?: string })?.name === "tenantId") activeTenantId = Number(val); return { col, val }; }),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
}));

async function buildApp() {
  const settingsRouter = (await import("../settings")).default;
  const app = express();
  app.use(express.json());
  app.use("/api", settingsRouter);
  return app;
}

beforeEach(() => {
  activeTenantId = 1;
  for (const [tenantId, row] of Object.entries(settingsRows)) {
    row.id = Number(tenantId);
    row.tenantId = Number(tenantId);
    row.orderRoutingRule = "round_robin";
    row.defaultEtaMinutes = 30;
    delete row.conciergeIntroSteps;
  }
  mockActor = { id: 1, role: "admin", email: "a@x", tenantId: 1 };
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

  it("tenant admin without tenant assignment cannot edit settings", async () => {
    mockActor = { id: 3, role: "admin", email: "orphan@x" };
    const res = await supertest(await buildApp()).put("/api/admin/settings").send({ defaultEtaMinutes: 45 });
    expect(res.status).toBe(403);
  });

  it("non-supervisors cannot read or write", async () => {
    mockActor = { id: 2, role: "customer_service_rep", email: "c@x", tenantId: 1 };
    const r1 = await supertest(await buildApp()).get("/api/admin/settings");
    const r2 = await supertest(await buildApp()).put("/api/admin/settings").send({ orderRoutingRule: "round_robin" });
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
  });
});

describe("/admin/concierge-steps — persistence and tenant scope", () => {
  const tenantOneSteps = [
    { emoji: "⚡", title: "Tenant One", body: "Only tenant one can see this", cta: "Go" },
  ];
  const tenantTwoSteps = [
    { emoji: "🛍️", title: "Tenant Two", body: "Only tenant two can see this", cta: "Shop" },
  ];

  it("saves and reloads AI Concierge steps from tenant-scoped DB settings", async () => {
    const app = await buildApp();
    const save = await supertest(app).put("/api/admin/concierge-steps").send(tenantOneSteps);
    expect(save.status).toBe(200);
    expect(save.body).toEqual(tenantOneSteps);

    const reload = await supertest(app).get("/api/admin/concierge-steps");
    expect(reload.status).toBe(200);
    expect(reload.body).toEqual(tenantOneSteps);
  });

  it("keeps Tenant A and Tenant B concierge steps isolated", async () => {
    const app = await buildApp();
    mockActor = { id: 1, role: "admin", email: "a@x", tenantId: 1 };
    expect((await supertest(app).put("/api/admin/concierge-steps").send(tenantOneSteps)).status).toBe(200);

    mockActor = { id: 2, role: "admin", email: "b@x", tenantId: 2 };
    expect((await supertest(app).put("/api/admin/concierge-steps").send(tenantTwoSteps)).status).toBe(200);
    expect((await supertest(app).get("/api/admin/concierge-steps")).body).toEqual(tenantTwoSteps);

    mockActor = { id: 1, role: "admin", email: "a@x", tenantId: 1 };
    expect((await supertest(app).get("/api/admin/concierge-steps")).body).toEqual(tenantOneSteps);
  });

  it("allows supervisors but denies unauthorized users", async () => {
    const app = await buildApp();
    mockActor = { id: 3, role: "supervisor", email: "s@x", tenantId: 1 };
    expect((await supertest(app).put("/api/admin/concierge-steps").send(tenantOneSteps)).status).toBe(200);

    mockActor = { id: 4, role: "user", email: "u@x", tenantId: 1 };
    expect((await supertest(app).put("/api/admin/concierge-steps").send(tenantOneSteps)).status).toBe(403);
  });

  it("rejects unknown step fields", async () => {
    const res = await supertest(await buildApp())
      .put("/api/admin/concierge-steps")
      .send([{ ...tenantOneSteps[0], tenantId: 2 }]);
    expect(res.status).toBe(400);
  });

  it("uses defaults only when DB concierge steps are absent", async () => {
    const app = await buildApp();
    const defaultRes = await supertest(app).get("/api/concierge/intro-steps");
    expect(defaultRes.status).toBe(200);
    expect(defaultRes.body[0].title).toBe("Hey! I'm Zappy");

    await supertest(app).put("/api/admin/concierge-steps").send(tenantOneSteps);
    const savedRes = await supertest(app).get("/api/concierge/intro-steps");
    expect(savedRes.body).toEqual(tenantOneSteps);
  });
});


describe("admin_settings tenant unique-index migration preflight", () => {
  it("checks duplicate tenant rows before creating the unique index", () => {
    const sql = readFileSync(new URL("../../../../../lib/db/drizzle/0019_tenant_scoped_concierge_settings.sql", import.meta.url), "utf8");
    expect(sql).toContain("Preflight failed: admin_settings contains duplicate tenant_id rows");
    expect(sql.indexOf("DO $$")).toBeLessThan(sql.indexOf("CREATE UNIQUE INDEX"));
    expect(sql).toContain("HAVING count(*) > 1");
  });
});
