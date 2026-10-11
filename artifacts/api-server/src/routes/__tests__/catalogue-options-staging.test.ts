import express from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const state = vi.hoisted(() => ({ tenantId: 1, calls: 0, products: [] as Record<string, unknown>[], options: [] as Record<string, unknown>[],
  txResults: [] as Record<string, unknown>[][], txQueries: [] as unknown[] }));
vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  loadDbUser: (req: { dbUser?: unknown }, _res: unknown, next: () => void) => { req.dbUser = { id: 1, role: "customer", tenantId: state.tenantId }; next(); },
  requireDbUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApproved: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("@workspace/db", () => ({ db: {
  execute: vi.fn(async () => (++state.calls % 2 === 1 ? state.products : state.options)),
  transaction: vi.fn(async (callback: (tx: { execute: (query: unknown) => Promise<Record<string, unknown>[]> }) => Promise<unknown>) =>
    callback({ execute: async (query: unknown) => { state.txQueries.push(query); return state.txResults.shift() ?? []; } })),
} }));
vi.mock("../../lib/cataloguePolicy", () => ({ recommendReplenishment: vi.fn() }));
vi.mock("../../lib/inventoryAuthority", () => ({ upsertInventoryBalanceThroughAuthority: vi.fn() }));

const router = (await import("../catalogue-products")).default;
const app = express();
app.use(express.json());
app.use("/api", router);

beforeEach(() => {
  state.tenantId = 1;
  state.calls = 0;
  state.products = [];
  state.options = [];
  state.txResults = [];
  state.txQueries = [];
});

describe("customer product options", () => {
  it("returns one grouped product with all available variants and their server prices", async () => {
    state.products = [{ id: 1, tenantId: 1, name: "T-Shirt", inventoryModel: "SEPARATE_VARIANTS", locationEvaluation: "PER_LOCATION", active: true }];
    state.options = [
      { id: 11, productId: 1, catalogItemId: 21, label: "Small", price: "20.00" },
      { id: 12, productId: 1, catalogItemId: 22, label: "Medium", price: "22.00" },
      { id: 13, productId: 1, catalogItemId: 23, label: "Large", price: "24.00" },
    ];
    const response = await supertest(app).get("/api/catalogue/products");
    expect(response.status).toBe(200);
    expect(response.body.products).toHaveLength(1);
    expect(response.body.products[0].options.map((option: { id: number; label: string; price: string }) => [option.id, option.label, option.price]))
      .toEqual([[11, "Small", "20.00"], [12, "Medium", "22.00"], [13, "Large", "24.00"]]);
  });

  it("queries tenant-scoped active, non-held options", () => {
    const customerQuery = readFileSync(new URL("../../lib/catalogueSellable.ts", import.meta.url), "utf8");
    for (const predicate of ["co.tenant_id = ${tenantId}", "co.active = true", "option_values AS \"optionValues\"", "ci.is_available = true", "alavont_in_stock IS DISTINCT FROM false", "archived", "safeOnlyDuplicate", "complianceHold"]) {
      expect(customerQuery).toContain(predicate);
    }
  });

  it("uses the admin Add option path to attach a separate variant to its parent", async () => {
    state.txResults = [
      [{ id: 179, name: "T-Shirt", inventoryModel: "SEPARATE_VARIANTS" }],
      [{ category: "Apparel", baseUnit: "each", inventoryItemId: 179 }],
      [{ inventoryItemId: 179, catalogItemId: 182, inventoryCatalogItemId: 182 }],
      [], [], [], [],
      [{ id: 184 }],
      [{ id: 181, productId: 181, inventoryItemId: 181 }],
      [], [],
    ];
    const response = await supertest(app).post("/api/admin/catalogue/products/179/options")
      .send({ label: "Large", sku: "TS-L", price: "24.00", consumptionQuantity: "1.000000" });
    expect(response.status, response.text).toBe(201);
    expect(response.body).toEqual({ optionId: 181, catalogItemId: 184, inventoryItemId: 181, optionValues: { Option: "Large" }, idempotent: false });
    expect(state.txQueries).toHaveLength(11);
    const source = readFileSync(new URL("../catalogue-products.ts", import.meta.url), "utf8");
    expect(source).toContain("UPDATE catalogue_options SET product_id = ${product.id}, label = ${body.label}");
  });

  it("accepts a structured variant combination and rejects malformed attribute data", async () => {
    state.txResults = [
      [{ id: 179, name: "T-Shirt", inventoryModel: "SEPARATE_VARIANTS" }],
      [{ category: "Apparel", baseUnit: "each", inventoryItemId: 179 }],
      [{ inventoryItemId: 179, catalogItemId: 182, inventoryCatalogItemId: 182 }],
      [], [], [], [], [], [],
      [{ id: 184 }], [{ id: 181, productId: 181, inventoryItemId: 181 }], [], [],
    ];
    const valid = await supertest(app).post("/api/admin/catalogue/products/179/options")
      .send({ label: "Red / Medium", optionValues: { Color: "Red", Size: "M" }, sku: "TS-R-M", barcode: "000111", price: "25.00", compareAtPrice: "30.00", consumptionQuantity: "1.000000" });
    expect(valid.status, valid.text).toBe(201);
    expect(valid.body.optionValues).toEqual({ Color: "Red", Size: "M" });
    const malformed = await supertest(app).post("/api/admin/catalogue/products/179/options")
      .send({ label: "Bad", optionValues: { Color: "" }, sku: "BAD", price: "1.00", consumptionQuantity: "1" });
    expect(malformed.status).toBe(400);
  });

  it("rejects the operation that exposed an existing SHARED product with three inventory identities", async () => {
    state.txResults = [
      [{ id: 1, name: "Existing product", inventoryModel: "SHARED" }],
      [{ category: "Apparel", baseUnit: "each", inventoryItemId: 1 }],
      [{ inventoryItemId: 1, catalogItemId: 1, inventoryCatalogItemId: 1 },
        { inventoryItemId: 185, catalogItemId: 188, inventoryCatalogItemId: 188 },
        { inventoryItemId: 186, catalogItemId: 189, inventoryCatalogItemId: 189 }],
    ];
    const response = await supertest(app).post("/api/admin/catalogue/products/1/options")
      .send({ label: "Large", price: "5.00", consumptionQuantity: "1.000000" });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/controlled reconciliation/);
    expect(state.txQueries).toHaveLength(4); // no catalogue insert
  });

  it("reuses the trusted inventory item when adding an option to a SHARED product", async () => {
    state.txResults = [
      [{ id: 182, name: "Coffee Beans", inventoryModel: "SHARED" }],
      [{ category: "Coffee", baseUnit: "g", inventoryItemId: 182 }],
      [{ inventoryItemId: 182, catalogItemId: 182, inventoryCatalogItemId: 182 },
        { inventoryItemId: 182, catalogItemId: 191, inventoryCatalogItemId: 182 }],
      [],
      [],
      [{ id: 193 }],
      [{ id: 190, productId: 190, inventoryItemId: 190 }],
      [], [], [],
    ];
    const response = await supertest(app).post("/api/admin/catalogue/products/182/options")
      .send({ label: "1 kg", price: "20.00", consumptionQuantity: "1000.000000" });
    expect(response.status, response.text).toBe(201);
    expect(response.body.inventoryItemId).toBe(182);
  });

  it("rejects a model switch to SHARED while separate options have different inventory items", async () => {
    state.txResults = [
      [{ id: 1, name: "Existing product", inventoryModel: "SEPARATE_VARIANTS", locationEvaluation: "PER_LOCATION" }],
      [{ inventoryItemId: 1, catalogItemId: 1, inventoryCatalogItemId: 1 },
        { inventoryItemId: 185, catalogItemId: 188, inventoryCatalogItemId: 188 },
        { inventoryItemId: 186, catalogItemId: 189, inventoryCatalogItemId: 189 }],
    ];
    const response = await supertest(app).patch("/api/admin/catalogue/products/1")
      .send({ inventoryModel: "SHARED" });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("CONTROLLED_RECONCILIATION_REQUIRED");
    expect(state.txQueries).toHaveLength(2); // no update
  });

  it("rejects a model switch to SEPARATE_VARIANTS while options share an inventory item", async () => {
    state.txResults = [
      [{ id: 182, name: "Coffee Beans", inventoryModel: "SHARED", locationEvaluation: "COMBINED_LOCATIONS" }],
      [{ inventoryItemId: 182, catalogItemId: 182, inventoryCatalogItemId: 182 },
        { inventoryItemId: 182, catalogItemId: 191, inventoryCatalogItemId: 182 }],
    ];
    const response = await supertest(app).patch("/api/admin/catalogue/products/182")
      .send({ inventoryModel: "SEPARATE_VARIANTS" });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("CONTROLLED_RECONCILIATION_REQUIRED");
    expect(state.txQueries).toHaveLength(2);
  });

  it("rejects a separate option whose inventory identity belongs to another catalogue item", async () => {
    state.txResults = [
      [{ id: 179, name: "T-Shirt", inventoryModel: "SEPARATE_VARIANTS" }],
      [{ category: "Apparel", baseUnit: "each", inventoryItemId: 179 }],
      [{ inventoryItemId: 179, catalogItemId: 182, inventoryCatalogItemId: 182 },
        { inventoryItemId: 180, catalogItemId: 183, inventoryCatalogItemId: 182 }],
    ];
    const response = await supertest(app).post("/api/admin/catalogue/products/179/options")
      .send({ label: "Large", price: "24.00", consumptionQuantity: "1.000000" });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/own catalogue inventory item/);
    expect(state.txQueries).toHaveLength(4);
  });
});
