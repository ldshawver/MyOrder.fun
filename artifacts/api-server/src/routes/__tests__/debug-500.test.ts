import { describe, it, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

let mockUserId = "csr-clerk-id";
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({ userId: mockUserId })),
  clerkClient: { users: { getUser: vi.fn().mockResolvedValue({ publicMetadata: {} }) } },
}));

const thenableChain = (resolved: unknown[]): Record<string, unknown> => {
  const promise = Promise.resolve(resolved);
  const obj = promise as unknown as Record<string, unknown>;
  obj.limit = () => Promise.resolve(resolved);
  obj.orderBy = () => Promise.resolve(resolved);
  obj.where = vi.fn(() => thenableChain(resolved));
  obj.from = vi.fn(() => thenableChain(resolved));
  return obj;
};

vi.mock("@workspace/db", () => {
  const usersTable = { clerkId: "c", id: "i", email: "e", firstName: "f", lastName: "l" };
  const labTechShiftsTable = { techId: "t", status: "s", id: "id", csrDeliveryOptIn: "o", csrDeliveryEarnings: "earn", setupJson: "sj", clockedInAt: "cia" };
  const shiftInventoryItemsTable = { shiftId: "si", displayOrder: "do", id: "id" };
  const inventoryTemplatesTable = { isActive: "ia", displayOrder: "do", tenantId: "ti", catalogItemId: "ci" };
  const catalogItemsTable = { isAvailable: "av", id: "id", price: "p" };
  const ordersTable = { assignedShiftId: "asi", id: "id", customerId: "cid", total: "tot" };
  const orderItemsTable = { orderId: "oi" };
  const auditLogsTable = {};
  const csrBoxesTable = { id: "id", tenantId: "ti", slug: "s", label: "l", isActive: "ia", displayOrder: "do" };
  const inventoryLocationsTable = { id: "id", tenantId: "ti", name: "n", type: "t", isActive: "ia", displayOrder: "do" };
  const inventoryBalancesTable = { id: "id", tenantId: "ti", productId: "pi", locationId: "li", quantityOnHand: "qoh" };
  const adminSettingsTable = {};

  let n = 0;
  const user = { id: 50, clerkId: "csr-clerk-id", email: "e@e.com", firstName: "A", lastName: "B", role: "customer_service_rep", status: "approved", isActive: true };

  const db = {
    execute: vi.fn(() => Promise.resolve()),
    select: vi.fn(() => { n++; console.log("db.select call #", n); return thenableChain(n === 1 ? [user] : []); }),
    insert: vi.fn((table: unknown) => {
      console.log("db.insert called, table===auditLogsTable:", table === auditLogsTable);
      if (table === auditLogsTable) {
        return { values: vi.fn(() => Promise.resolve(undefined)) };
      }
      return {
        values: vi.fn(() => ({
          returning: () => Promise.resolve([{ id: 999, tenantId: 1, techId: 50, status: "active", clockedInAt: new Date(), cashBankStart: "0", csrDeliveryEarnings: "0", csrDeliveryOptIn: false, setupJson: {} }]),
        })),
      };
    }),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })),
    delete: vi.fn(),
  };
  return { db, usersTable, labTechShiftsTable, shiftInventoryItemsTable, inventoryTemplatesTable, catalogItemsTable, ordersTable, orderItemsTable, auditLogsTable, csrBoxesTable, inventoryLocationsTable, inventoryBalancesTable, adminSettingsTable };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((c, v) => ({ c, v })),
  and: vi.fn((...a) => a),
  asc: vi.fn((c) => c),
  desc: vi.fn((c) => c),
  sql: vi.fn(),
  inArray: vi.fn(() => ({})),
}));

vi.mock("../../lib/singleTenant", () => ({ getHouseTenantId: vi.fn().mockResolvedValue(1) }));
vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
}));

import shiftsRouter from "../shifts";

describe("debug clock-in 500", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("captures actual error body on clock-in", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as Record<string, unknown>).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
      next();
    });
    // Global error handler to see errors
    app.use("/api", shiftsRouter);
    app.use((err: unknown, _req: unknown, res: { status: (n: number) => { json: (o: unknown) => void } }, _next: unknown) => {
      console.log("UNHANDLED ERROR:", err);
      res.status(500).json({ unhandled: String(err) });
    });

    const res = await supertest(app).post("/api/shifts/clock-in").send({});
    console.log("STATUS:", res.status);
    console.log("BODY:", JSON.stringify(res.body, null, 2));
  });
});
