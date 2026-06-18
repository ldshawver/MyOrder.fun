import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import supertest from "supertest";

type Actor = { id: number; role: string; email: string; tenantId?: number | null };
let mockActor: Actor = { id: 10, role: "user", email: "u@x", tenantId: 1 };
const settingsRows: Record<string, unknown>[] = [{ id: 1, tenantId: 1, customerDisclaimerVersion: 2 }];
const acceptanceRows: Record<string, unknown>[] = [];

const adminSettingsTable = { __t: "settings", tenantId: "tenantId" };
const customerDisclaimerAcceptancesTable = {
  __t: "acceptances",
  tenantId: "tenantId",
  userId: "userId",
  disclaimerVersion: "disclaimerVersion",
};

function rowsFor(table: { __t?: string }) {
  return table.__t === "acceptances" ? acceptanceRows : settingsRows;
}

vi.mock("@workspace/db", () => ({
  adminSettingsTable,
  customerDisclaimerAcceptancesTable,
  db: {
    select: () => ({
      from: (table: { __t?: string }) => ({
        where: (predicate: unknown) => ({
          limit: async () => rowsFor(table).filter((row) => (predicate as (r: Record<string, unknown>) => boolean)(row)).slice(0, 1),
        }),
      }),
    }),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: unknown) => (row: Record<string, unknown>) => row[col] === val,
  and: (...preds: Array<(row: Record<string, unknown>) => boolean>) => (row: Record<string, unknown>) => preds.every((p) => p(row)),
}));

async function buildApp() {
  vi.resetModules();
  const { requireCurrentCustomerDisclaimerAcceptance } = await import("../customerDisclaimerEnforcement");
  const app = express();
  app.use(express.json());
  app.post("/mutate", (req, _res, next) => { req.dbUser = mockActor as never; next(); }, requireCurrentCustomerDisclaimerAcceptance("orders.create"), (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  mockActor = { id: 10, role: "user", email: "u@x", tenantId: 1 };
  settingsRows.splice(0, settingsRows.length, { id: 1, tenantId: 1, customerDisclaimerVersion: 2 });
  acceptanceRows.length = 0;
});

describe("requireCurrentCustomerDisclaimerAcceptance", () => {
  it("blocks customer mutations until current disclaimer version is accepted", async () => {
    const res = await supertest(await buildApp()).post("/mutate").send({});
    expect(res.status).toBe(428);
    expect(res.body).toMatchObject({ code: "DISCLAIMER_ACCEPTANCE_REQUIRED", action: "orders.create", version: 2 });
  });

  it("allows customer mutation after current version acceptance", async () => {
    acceptanceRows.push({ id: 1, tenantId: 1, userId: 10, disclaimerVersion: 2 });
    const res = await supertest(await buildApp()).post("/mutate").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("requires reacceptance when stored acceptance is for an older version", async () => {
    acceptanceRows.push({ id: 1, tenantId: 1, userId: 10, disclaimerVersion: 1 });
    const res = await supertest(await buildApp()).post("/mutate").send({});
    expect(res.status).toBe(428);
    expect(res.body.version).toBe(2);
  });

  it("bypasses staff roles so operational/admin mutations are not blocked", async () => {
    mockActor = { id: 20, role: "csr", email: "csr@x", tenantId: 1 };
    const res = await supertest(await buildApp()).post("/mutate").send({});
    expect(res.status).toBe(200);
  });

  it("does not allow cross-tenant acceptance to satisfy the gate", async () => {
    acceptanceRows.push({ id: 1, tenantId: 2, userId: 10, disclaimerVersion: 2 });
    const res = await supertest(await buildApp()).post("/mutate").send({});
    expect(res.status).toBe(428);
  });
});
