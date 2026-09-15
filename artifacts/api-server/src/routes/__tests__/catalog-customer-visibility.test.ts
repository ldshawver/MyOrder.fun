import express from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const actor = vi.hoisted(() => ({ tenantId: 1, role: "customer" }));
const rows = vi.hoisted(() => ({ catalog: [] as Record<string, unknown>[], showOutOfStock: false }));

vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  loadDbUser: (req: { dbUser?: unknown }, _res: unknown, next: () => void) => { req.dbUser = { id: 1, email: "customer@example.test", status: "approved", ...actor }; next(); },
  requireDbUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApproved: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  normalizeRole: (role: string) => role,
  writeAuditLog: vi.fn(),
}));
vi.mock("../../lib/singleTenant", () => ({ getHouseTenantId: vi.fn(async () => 1) }));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ kind: "and", args })),
  asc: vi.fn((value: unknown) => value),
  eq: vi.fn((column: string, value: unknown) => ({ kind: "eq", column, value })),
  isNull: vi.fn((column: string) => ({ kind: "isNull", column })),
  sql: Object.assign(vi.fn(() => ({ kind: "sql" })), { raw: vi.fn(() => ({ kind: "sql" })) }),
}));
vi.mock("@workspace/db", () => {
  const catalogItemsTable = { _name: "catalog", tenantId: "tenantId", name: "name", id: "id" };
  const adminSettingsTable = { _name: "settings", showOutOfStock: "showOutOfStock" };
  const inventoryBalancesTable = { _name: "balances", tenantId: "tenantId", productId: "productId", quantityOnHand: "quantityOnHand", locationId: "locationId", inventoryKind: "inventoryKind", isSellable: "isSellable", quarantinedAt: "quarantinedAt" };
  const inventoryLocationsTable = { _name: "locations", tenantId: "tenantId", id: "id", isActive: "isActive" };
  const inventoryTemplatesTable = { _name: "templates" };
  const orderItemsTable = { _name: "orderItems" };
  const byTenant = (condition: unknown) => {
    const candidate = condition as { kind?: string; column?: string; value?: unknown };
    return candidate?.kind === "eq" && candidate.column === "tenantId" ? rows.catalog.filter(row => row.tenantId === candidate.value) : rows.catalog;
  };
  const db = {
    execute: vi.fn(async () => []),
    select: vi.fn((_selection?: Record<string, unknown>) => ({
      from: (table: { _name: string }) => {
        if (table._name === "catalog") {
          return {
            where: (condition: unknown) => ({ orderBy: async () => byTenant(condition), limit: async () => byTenant(condition).slice(0, 1) }),
          };
        }
        if (table._name === "settings") return { limit: async () => [{ showOutOfStock: rows.showOutOfStock }] };
        if (table._name === "balances") {
          return { innerJoin: () => ({ where: () => ({ groupBy: async () => [] }) }) };
        }
        return { where: () => ({ limit: async () => [] }) };
      },
    })),
    update: vi.fn(), insert: vi.fn(), delete: vi.fn(), transaction: vi.fn(),
  };
  return { db, adminSettingsTable, catalogItemsTable, inventoryTemplatesTable, inventoryBalancesTable, inventoryLocationsTable, orderItemsTable };
});

const catalogRouter = (await import("../catalog")).default;
const app = express();
app.use((req, _res, next) => { req.log = { info: vi.fn() } as never; next(); });
app.use("/api", catalogRouter);

function catalogRow(id: number, patch: Record<string, unknown> = {}) {
  const now = new Date("2026-09-15T00:00:00.000Z");
  return {
    id, tenantId: 1, name: `Item ${id}`, category: "Category", price: "10.00", stockQuantity: "0", isAvailable: true,
    alavontInStock: true, isLocalAlavont: true, isWooManaged: false, metadata: {}, createdAt: now, updatedAt: now,
    ...patch,
  };
}

beforeEach(() => {
  actor.tenantId = 1;
  actor.role = "customer";
  rows.showOutOfStock = false;
  rows.catalog = [];
});

describe("customer catalogue visibility", () => {
  it("returns only the tenant's eligible local catalogue rows without using inventory location or customer identity as a predicate", async () => {
    rows.catalog = [
      catalogRow(1),
      catalogRow(2, { tenantId: 2 }),
      catalogRow(3, { isAvailable: false }),
      catalogRow(4, { alavontInStock: false, metadata: { complianceHold: true } }),
      catalogRow(5, { metadata: { archived: true } }),
      catalogRow(6, { metadata: { safeOnlyDuplicate: true } }),
      catalogRow(7, { isWooManaged: true, merchantProductSource: "woo", wooProductId: "woo-7" }),
    ];

    const response = await supertest(app).get("/api/catalog?limit=200&mode=alavont");

    expect(response.status, response.text).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items.map((item: { id: number }) => item.id)).toEqual([1]);
  });

  it("keeps the customer catalogue complete across pages and does not apply a second frontend-style filter", async () => {
    rows.catalog = Array.from({ length: 25 }, (_, index) => catalogRow(index + 1));

    const first = await supertest(app).get("/api/catalog?limit=20&page=1&mode=alavont");
    const second = await supertest(app).get("/api/catalog?limit=20&page=2&mode=alavont");

    expect(first.status, first.text).toBe(200);
    expect(first.body).toMatchObject({ total: 25, page: 1, limit: 20 });
    expect(first.body.items).toHaveLength(20);
    expect(second.status, second.text).toBe(200);
    expect(second.body).toMatchObject({ total: 25, page: 2, limit: 20 });
    expect(second.body.items.map((item: { id: number }) => item.id)).toEqual([5, 6, 7, 8, 9]);
  });
});
