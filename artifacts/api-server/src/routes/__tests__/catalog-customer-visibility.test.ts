import express from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const actor = vi.hoisted(() => ({ tenantId: 1, role: "customer" }));
const rows = vi.hoisted(() => ({ catalog: [] as Record<string, unknown>[], selectedIds: [] as number[], showOutOfStock: false,
  settingsPresent: true, settingsError: null as Error | null,
  products: [] as Record<string, unknown>[], options: [] as Record<string, unknown>[],
  sellableSchema: "available" as "available" | "absent" | "partial", executeError: null as Error | null,
  executedSql: [] as string[] }));

vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  loadDbUser: (req: { dbUser?: unknown }, _res: unknown, next: () => void) => { req.dbUser = { id: 1, email: "customer@example.test", status: "approved", ...actor }; next(); },
  requireDbUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireCatalogReadAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApproved: (_req: unknown, _res: unknown, next: () => void) => next(),
  evaluateAccountApproval: () => ({ allowed: true, reason: "valid_provenance" }),
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
  sql: Object.assign(vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ kind: "sql", text: [...strings].join("?"), values })), {
    raw: vi.fn((text: string) => ({ kind: "sql", text })),
    join: vi.fn((parts: Array<{ text?: string }>) => ({ kind: "sql", text: parts.map(part => part.text ?? "?").join(",") })),
  }),
}));
vi.mock("@workspace/db", () => {
  const catalogItemsTable = { _name: "catalog", tenantId: "tenantId", name: "name", id: "id", isAvailable: "isAvailable", metadata: "metadata" };
  const adminSettingsTable = { _name: "settings", showOutOfStock: "showOutOfStock" };
  const inventoryBalancesTable = { _name: "balances", tenantId: "tenantId", productId: "productId", quantityOnHand: "quantityOnHand", locationId: "locationId", inventoryKind: "inventoryKind", isSellable: "isSellable", quarantinedAt: "quarantinedAt" };
  const inventoryLocationsTable = { _name: "locations", tenantId: "tenantId", id: "id", isActive: "isActive" };
  const inventoryTemplatesTable = { _name: "templates" };
  const orderItemsTable = { _name: "orderItems" };
  type Condition = { kind: string; args?: Condition[]; column?: string; value?: unknown; text?: string; values?: string[] };
  // Evaluate the query predicates, so filtering only after SELECT cannot pass
  // the database-query assertion below.
  const matches = (row: Record<string, unknown>, condition?: Condition): boolean => {
    if (!condition) return true;
    if (condition.kind === "and") return condition.args!.every(part => matches(row, part));
    if (condition.kind === "eq") return row[condition.column!] === condition.value;
    if (condition.kind === "sql") {
      const metadata = (row[condition.values![0]] ?? {}) as Record<string, unknown>;
      const key = condition.text!.match(/->>'([^']+)'/)?.[1];
      if (!key) throw new Error(`Unexpected SQL predicate: ${condition.text}`);
      return condition.text!.includes("IS NULL") ? metadata[key] == null : String(metadata[key] ?? false) !== "true";
    }
    throw new Error(`Unexpected predicate: ${condition.kind}`);
  };
  const db = {
    execute: vi.fn(async (query: { text?: string }) => {
      const queryText = query.text ?? "";
      rows.executedSql.push(queryText);
      if (rows.executeError) throw rows.executeError;
      if (queryText.includes("required_columns")) {
        if (rows.sellableSchema === "partial") return [{ presentTableCount: 2, presentFeatureMarkerCount: 1, presentColumnCount: 1, missingColumnCount: 43, presentIndexCount: 0, presentFunctionCount: 0, presentTriggerCount: 0 }];
        const available = rows.sellableSchema === "available";
        return [{
          presentTableCount: available ? 5 : 1,
          presentFeatureMarkerCount: available ? 15 : 0,
          presentColumnCount: available ? 44 : 10,
          missingColumnCount: available ? 0 : 1,
          presentIndexCount: available ? 1 : 0,
          presentFunctionCount: available ? 2 : 0,
          presentTriggerCount: available ? 2 : 0,
        }];
      }
      if (queryText.includes("FROM catalogue_products")) return rows.products;
      if (queryText.includes("FROM catalogue_options")) return rows.options;
      return [];
    }),
    select: vi.fn((_selection?: Record<string, unknown>) => ({
      from: (table: { _name: string }) => {
        if (table._name === "catalog") {
          return {
            where: (condition: Condition) => {
              const selected = rows.catalog.filter(row => matches(row, condition));
              rows.selectedIds = selected.map(row => row.id as number);
              return Object.assign(Promise.resolve(selected), { orderBy: async () => selected, limit: async () => selected.slice(0, 1) });
            },
          };
        }
        if (table._name === "settings") return { where: () => ({ limit: async () => {
          if (rows.settingsError) throw rows.settingsError;
          return rows.settingsPresent ? [{ showOutOfStock: rows.showOutOfStock }] : [];
        } }) };
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
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: "Internal Server Error" });
});

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
  rows.settingsPresent = true;
  rows.settingsError = null;
  rows.catalog = [];
  rows.products = [];
  rows.options = [];
  rows.sellableSchema = "available";
  rows.executeError = null;
  rows.executedSql = [];
});

describe("customer catalogue visibility", () => {
  it("uses the default when the optional tenant setting row is absent", async () => {
    rows.settingsPresent = false;
    rows.catalog = [catalogRow(20, { alavontInStock: false })];

    const response = await supertest(app).get("/api/catalog?limit=200&mode=alavont");

    expect(response.status, response.text).toBe(200);
    expect(response.body.items).toEqual([]);
  });

  it("propagates unexpected tenant-setting database errors", async () => {
    rows.catalog = [catalogRow(21)];
    rows.settingsError = new Error("settings database unavailable");

    const response = await supertest(app).get("/api/catalog?limit=200&mode=alavont");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error" });
  });

  it("embeds all sellable sibling options on the actual customer card response", async () => {
    rows.catalog = [catalogRow(182, { name: "T-Shirt Small", price: "20.00" }),
      catalogRow(183, { name: "T-Shirt Medium", price: "22.00" }),
      catalogRow(184, { name: "T-Shirt Large", price: "24.00" })];
    rows.products = [{ id: 179, tenantId: 1, name: "T-Shirt", active: true }];
    rows.options = [
      { id: 179, productId: 179, catalogItemId: 182, label: "Small", price: "20.00", sku: null },
      { id: 180, productId: 179, catalogItemId: 183, label: "Medium", price: "22.00", sku: null },
      { id: 181, productId: 179, catalogItemId: 184, label: "Large", price: "24.00", sku: null },
    ];
    const response = await supertest(app).get("/api/catalog?limit=200&mode=alavont");
    expect(response.status, response.text).toBe(200);
    expect(response.body.items).toHaveLength(3);
    expect(response.body.items[0].sellableProduct).toMatchObject({ id: 179, name: "T-Shirt" });
    expect(response.body.items[0].sellableProduct.options.map((option: { id: number; label: string }) => [option.id, option.label]))
      .toEqual([[179, "Small"], [180, "Medium"], [181, "Large"]]);
  });
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

  it("serves the tenant-scoped base catalog when the optional 0070 schema is wholly absent", async () => {
    rows.sellableSchema = "absent";
    rows.catalog = [catalogRow(1)];

    const response = await supertest(app).get("/api/catalog?limit=200&page=1&mode=alavont");

    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({ total: 1, items: [{ id: 1 }] });
    expect(response.body.items[0]).not.toHaveProperty("sellableProduct");
    expect(rows.executedSql).toHaveLength(1);
    expect(rows.executedSql.some(query => /\b(ALTER|CREATE|DROP|INSERT|UPDATE|DELETE)\b/i.test(query))).toBe(false);
  });

  it("does not confuse an empty successful response with a schema failure", async () => {
    rows.sellableSchema = "absent";
    const response = await supertest(app).get("/api/catalog?limit=200&page=1&mode=alavont");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 0, items: [] });
  });

  it("fails visibly if the optional schema is partially installed", async () => {
    rows.sellableSchema = "partial";
    const response = await supertest(app).get("/api/catalog?limit=200&page=1&mode=alavont");
    expect(response.status).toBe(500);
  });

  it("propagates schema-inspection database errors instead of treating them as an absent feature", async () => {
    rows.executeError = new Error("synthetic database failure");
    const response = await supertest(app).get("/api/catalog?limit=200&page=1&mode=alavont");
    expect(response.status).toBe(500);
    expect(rows.executedSql).toHaveLength(1);
  });

  it("rejects missing tenant selection and cross-tenant selection before catalog queries", async () => {
    actor.role = "global_admin";
    actor.tenantId = null;
    const missing = await supertest(app).get("/api/catalog?mode=alavont");
    expect(missing.status).toBe(403);
    expect(rows.executedSql).toHaveLength(0);

    actor.role = "admin";
    actor.tenantId = 1;
    const crossTenant = await supertest(app).get("/api/catalog?tenantId=2&mode=alavont");
    expect(crossTenant.status).toBe(403);
    expect(rows.executedSql).toHaveLength(0);
  });

  it("returns restrictive server-derived lifecycle states to an administrator without reactivating the rows", async () => {
    actor.role = "admin";
    rows.catalog = [
      catalogRow(1),
      catalogRow(2, { isAvailable: false }),
      catalogRow(3, { isAvailable: true, metadata: { complianceHold: true } }),
      catalogRow(4, { isAvailable: true, metadata: { archived: true } }),
    ];

    const response = await supertest(app).get("/api/catalog?limit=200&mode=alavont");

    expect(response.status, response.text).toBe(200);
    expect(response.body.items.map((item: { id: number; lifecycleStatus: string }) => [item.id, item.lifecycleStatus]))
      .toEqual([[1, "customer_visible"], [2, "unavailable_hidden"], [3, "compliance_hold"], [4, "archived"]]);
    expect(response.body.items.find((item: { id: number }) => item.id === 4)?.isAvailable).toBe(true);
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

const restrictedStates = [
  { state: "archived", patch: { metadata: { archived: true } } },
  { state: "compliance hold", patch: { metadata: { complianceHold: true } } },
  { state: "not for sale", patch: { isAvailable: false } },
  { state: "merged", patch: { metadata: { mergedIntoCatalogItemId: 99 } } },
];

describe.each(restrictedStates)("$state eligibility", ({ patch }) => {
  it.each([false, true])("omits restricted rows in SQL with showOutOfStock=%s in both menus", async (showOutOfStock) => {
    rows.showOutOfStock = showOutOfStock;
    for (const mode of ["alavont", "lucifer"]) {
      const source = mode === "lucifer" ? { isWooManaged: true, merchantProductSource: "woo", wooProductId: "100" } : {};
      rows.catalog = [catalogRow(1, { ...source, ...patch }), catalogRow(2, source)];
      for (const filter of ["", "&available=true", "&available=false", "&search=Item&category=Category"]) {
        const response = await supertest(app).get(`/api/catalog?mode=${mode}&limit=1${filter}`);
        expect(response.status, response.text).toBe(200);
        expect(rows.selectedIds).toEqual([2]);
        expect(response.body.total).toBe(1);
        expect(response.body.items.map((item: { id: number }) => item.id)).toEqual([2]);
      }
    }
  });

  it("returns 404 for direct customer lookup but preserves admin access and inventory history", async () => {
    rows.catalog = [catalogRow(1, patch), catalogRow(2)];
    const hidden = await supertest(app).get("/api/catalog/1");
    expect(hidden.status, hidden.text).toBe(404);
    expect(hidden.body).toEqual({ error: "Not found" });
    const active = await supertest(app).get("/api/catalog/2");
    expect(active.status, active.text).toBe(200);
    expect(active.body.id).toBe(2);
    for (const role of ["admin", "global_admin"]) {
      actor.role = role;
      const list = await supertest(app).get("/api/catalog");
      expect(list.status, list.text).toBe(200);
      expect(list.body.items.map((item: { id: number }) => item.id)).toEqual([1, 2]);
      const detail = await supertest(app).get("/api/catalog/1");
      expect(detail.status, detail.text).toBe(200);
      expect(detail.body.id).toBe(1);
    }
  });

  it("omits categories belonging only to restricted products", async () => {
    rows.catalog = [catalogRow(1, { ...patch, category: "Restricted" }), catalogRow(2, { category: "Active" })];
    const response = await supertest(app).get("/api/catalog/categories");
    expect(response.status, response.text).toBe(200);
    expect(response.body.categories).toEqual(["Active"]);
  });
});
