import express from "express";
import supertest from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@clerk/express", () => ({ clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(), getAuth: vi.fn(() => ({ userId: "user-clerk-id" })) }));
vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  loadDbUser: (req: { dbUser?: unknown }, _res: unknown, next: () => void) => { req.dbUser = { id: 1, role: "admin", status: "approved", email: "a@b.com", clerkId: "user-clerk-id" }; next(); },
  requireDbUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApproved: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../lib/singleTenant", () => ({ getHouseTenantId: vi.fn(async () => 1) }));
vi.mock("../../lib/inventoryBalances", () => ({ ensureStandardLocations: vi.fn(async () => undefined), ensureAllInventoryBalances: vi.fn(async () => ({ created: 0 })) }));

const state: { catalog: Record<string, unknown>[]; inventory: Record<string, unknown>[]; balances: Record<string, unknown>[]; locations: Record<string, unknown>[]; audit: Record<string, unknown>[]; snapshots: Record<string, unknown>[] } = { catalog: [], inventory: [], balances: [], locations: [{ id: 1, tenantId: 1, name: "Box 1", isActive: true }, { id: 2, tenantId: 1, name: "Box 2", isActive: true }, { id: 3, tenantId: 1, name: "Storefront", isActive: true }, { id: 4, tenantId: 1, name: "Backstock", isActive: true }], audit: [], snapshots: [] };

vi.mock("@workspace/db", () => {
  const col = (name: string) => name;
  const catalogItemsTable = { _name: "catalog_items", id: col("id"), tenantId: col("tenantId"), sku: col("sku"), merchantSku: col("merchantSku"), alavontId: col("alavontId"), catalogItemId: col("catalogItemId") };
  const inventoryTemplatesTable = { _name: "inventory_templates", id: col("id"), tenantId: col("tenantId"), catalogItemId: col("catalogItemId") };
  const inventoryLocationsTable = { _name: "inventory_locations", id: col("id"), tenantId: col("tenantId"), name: col("name"), isActive: col("isActive") };
  const inventoryBalancesTable = { _name: "inventory_balances", id: col("id"), tenantId: col("tenantId"), productId: col("productId"), locationId: col("locationId"), quantityOnHand: col("quantityOnHand") };
  const auditLogsTable = { _name: "audit_logs" };
  const query = (rows: Record<string, unknown>[]) => ({ where: () => query(rows), limit: () => Promise.resolve(rows.slice(0, 1)), then: (resolve: (v: unknown) => void) => resolve(rows) });
  const tableRows = (table: { _name?: string } | undefined, selection?: unknown) => {
    if (table?._name === "catalog_items") return selection ? state.catalog.map(r => ({ id: r.id, sku: r.sku })) : state.catalog;
    if (table?._name === "inventory_templates") return selection ? state.inventory.map(r => ({ id: r.id })) : state.inventory;
    if (table?._name === "inventory_locations") return state.locations;
    if (table?._name === "inventory_balances") return selection ? [] : state.balances;
    return [];
  };
  return { db: {
    select: vi.fn((selection?: unknown) => ({ from: (table: { _name?: string }) => query(tableRows(table, selection)) })),
    insert: vi.fn((table: { _name?: string }) => ({ values: (vals: Record<string, unknown>) => {
      const row = { id: table._name === "catalog_items" ? state.catalog.length + 1 : state.inventory.length + 1, ...vals };
      if (table._name === "catalog_items") state.catalog.push(row);
      if (table._name === "inventory_templates") state.inventory.push(row);
      if (table._name === "inventory_balances") state.balances.push(row);
      if (table._name === "audit_logs") state.audit.push(row);
      return { returning: () => Promise.resolve([row]), then: (resolve: (v: unknown) => void) => resolve(undefined) };
    } })),
    update: vi.fn((table: { _name?: string }) => ({ set: (vals: Record<string, unknown>) => ({ where: () => { const rows = table._name === "catalog_items" ? state.catalog : state.inventory; if (rows[0]) Object.assign(rows[0], vals); return Promise.resolve(); } }) })),
    delete: vi.fn((table: { _name?: string }) => ({ where: () => { if (table._name === "catalog_items") state.catalog = []; if (table._name === "inventory_templates") state.inventory = []; return Promise.resolve(); } })),
    execute: vi.fn((q: unknown) => { const text = String(q); if (text.includes("SELECT id, snapshot")) return Promise.resolve(state.snapshots); if (text.includes("INSERT INTO catalog_import_snapshots")) return Promise.resolve([{ id: 1 }]); return Promise.resolve([]); }),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn((await import("@workspace/db")).db)),
  }, catalogItemsTable, inventoryTemplatesTable, inventoryLocationsTable, inventoryBalancesTable, auditLogsTable };
});

const importRouter = (await import("../import")).default;
function buildApp() { const app = express(); app.use(express.json()); app.use("/api", importRouter); return app; }
const headers = "Regular Price,Sale Price,Active Sale,Alavont Category,Alavont Name,Alavont Image,Alavont Description,Alavont SKU,Safe Category,Safe Name,Safe Image,Safe Description,Box 1 Inventory,Box 2 Inventory,Storefront Inventory,Backstock Inventory";
const goodCsv = `${headers}\n12.50,9.99,true,Cat,Name,https://example.com/a.jpg,Desc,SKU-1,Safe cat,Safe,https://example.com/s.jpg,Safe desc,1,2,3,9\n`;
const oldHeaders = "sku,name,description,category,brand,price,unit,quantity_size,active,image_url,safe_name,safe_description,safe_category,safe_image_url,inventory_location,current_inventory,par_level,reorder_threshold,sort_order";
const oldCsv = `${oldHeaders}\nSKU-OLD,Old Name,Desc,Cat,alavont,12.50,ml,10,true,https://example.com/a.jpg,Safe,Safe desc,Safe cat,https://example.com/s.jpg,Back,9,3,2,1\n`;

beforeEach(() => { vi.clearAllMocks(); state.catalog = []; state.inventory = []; state.balances = []; state.audit = []; state.snapshots = []; });

describe("safe catalog import/export", () => {
  it("template matches accepted headers and includes a sample row", async () => {
    const res = await supertest(buildApp()).get("/api/admin/products/import-template");
    expect(res.status).toBe(200);
    const lines = res.text.split("\n");
    expect(lines[0]).toBe(headers);
    expect(lines[1]).toContain("SKU-001");
  });
  it("rejects unknown headers clearly", async () => {
    const res = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from(`${headers},bad\n${headers.split(",").map(() => "x").join(",")},x\n`), "bad.csv");
    expect(res.status).toBe(400);
    expect(res.body.extraColumns).toContain("bad");
  });
  it("requires confirmation before applying import", async () => {
    const res = await supertest(buildApp()).post("/api/admin/products/import").attach("file", Buffer.from(goodCsv), "catalog.csv");
    expect(res.status).toBe(409);
    expect(res.body.requiresConfirmation).toBe(true);
    expect(state.catalog).toHaveLength(0);
  });
  it("imports catalog and inventory/par together in a transaction when confirmed", async () => {
    const res = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from(goodCsv), "catalog.csv");
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    expect(state.catalog[0]).toMatchObject({ tenantId: 1, sku: "SKU-1", price: "9.99", regularPrice: "12.50" });
    expect(state.balances).toEqual(expect.arrayContaining([expect.objectContaining({ productId: 1, locationId: 1, quantityOnHand: "1.000" }), expect.objectContaining({ productId: 1, locationId: 4, quantityOnHand: "9.000" })]));
    const { db } = await import("@workspace/db");
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
  it("escapes formula-like exported cells", async () => {
    state.catalog.push({ id: 1, tenantId: 1, sku: "=BAD", name: "+Name", description: "Desc", category: "Cat", price: "1.00", isAvailable: true });
    const res = await supertest(buildApp()).get("/api/admin/products/export");
    expect(res.status).toBe(200);
    expect(res.text).toContain("'=BAD");
    expect(res.text).toContain("'+Name");
  });


  it("parse-headers accepts the provided Alavont/Safe spreadsheet headers and aliases", async () => {
    const uploadHeaders = [
      "Regular Price", "Sale Price", "Active Sale", "Alavont  Category", "Alavont Name",
      "Alavont Image", "Alavontb Description", "Alavont  ID", "Safe Category", "Safe Name",
      "Safe Image", "Safe Description", "Box 1 Inventory", "Box 2 Inventory", "Storefront Quantity", "Backstock Inventory",
    ].join(",");
    const row = ["10", "8", "true", "Cat", "Name", "https://example.com/a.jpg", "Desc", "SKU-A", "Safe Cat", "Safe Name", "https://example.com/s.jpg", "Safe Desc", "1", "2", "3", "4"].join(",");
    const res = await supertest(buildApp()).post("/api/admin/products/parse-headers").attach("file", Buffer.from(`${uploadHeaders}\n${row}\n`), "Alavont-N-Safe-Full-Inventory-import.csv");
    expect(res.status).toBe(200);
    expect(res.body.unknownHeaders).toEqual([]);
    expect(res.body.duplicateHeaders).toEqual([]);
    expect(res.body.headerMappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ original: "Sale Price", canonical: "Sale Price", recognized: true }),
      expect.objectContaining({ original: "Active Sale", canonical: "Active Sale", recognized: true }),
      expect.objectContaining({ original: "Storefront Quantity", canonical: "Storefront Inventory", recognized: true }),
      expect.objectContaining({ original: "Alavontb Description", canonical: "Alavont Description", recognized: true }),
      expect.objectContaining({ original: "Alavont  ID", canonical: "Alavont SKU", recognized: true }),
    ]));
  });

  it("template and export emit canonical Product Master headers only", async () => {
    const template = await supertest(buildApp()).get("/api/admin/products/import-template");
    expect(template.status).toBe(200);
    expect(template.text.split("\n")[0]).toBe(headers);
    state.catalog.push({ id: 1, tenantId: 1, sku: "SKU-1", name: "Name", description: "Desc", category: "Cat", price: "1.00", regularPrice: "1.00", isAvailable: true });
    const exported = await supertest(buildApp()).get("/api/admin/products/export");
    expect(exported.status).toBe(200);
    expect(exported.text.split("\n")[0]).toBe(headers);
    expect(exported.text.split("\n")[0]).not.toContain("alavont_in_stock");
    expect(exported.text.split("\n")[0]).not.toContain("quantity_size");
  });
  it("imports the old template during transition", async () => {
    const res = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from(oldCsv), "old.csv");
    expect(res.status).toBe(200);
    expect(state.catalog[0]).toMatchObject({ sku: "SKU-OLD", name: "Old Name", price: "12.50" });
  });
  it("blank inactive sale uses regular price", async () => {
    const csv = `${headers}\n15.00,7.00,,Cat,Name,https://example.com/a.jpg,Desc,SKU-2,Safe cat,Safe,https://example.com/s.jpg,Safe desc,0,0,0,0\n`;
    const res = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from(csv), "catalog.csv");
    expect(res.status).toBe(200);
    expect(state.catalog[0]).toMatchObject({ sku: "SKU-2", price: "15.00", regularPrice: "15.00" });
  });
  it("rejects invalid file types", async () => {
    const res = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from("nope"), "catalog.json");
    expect(res.status).toBe(400);
  });
});
