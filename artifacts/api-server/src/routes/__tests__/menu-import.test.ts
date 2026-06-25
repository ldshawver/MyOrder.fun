import express from "express";
import supertest from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { inArray, sql } from "drizzle-orm";

vi.mock("@clerk/express", () => ({ clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(), getAuth: vi.fn(() => ({ userId: "user-clerk-id" })) }));
vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  loadDbUser: (req: { dbUser?: unknown }, _res: unknown, next: () => void) => { req.dbUser = { id: 1, tenantId: 1, role: "admin", status: "approved", email: "a@b.com", clerkId: "user-clerk-id" }; next(); },
  requireDbUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApproved: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../lib/singleTenant", () => ({ getHouseTenantId: vi.fn(async () => 999) }));
vi.mock("../../lib/inventoryBalances", () => ({ ensureStandardLocations: vi.fn(async () => undefined), ensureAllInventoryBalances: vi.fn(async () => ({ created: 0 })) }));
vi.mock("../../lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

vi.mock("drizzle-orm", () => {
  const makeSql = (strings: TemplateStringsArray | string[], ...values: unknown[]) => ({
    strings: Array.from(strings),
    values,
    toString: () => Array.from(strings).join("?"),
  });
  return {
    and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
    eq: vi.fn((column: unknown, value: unknown) => ({ op: "eq", column, value })),
    inArray: vi.fn((column: unknown, values: unknown[]) => ({ op: "inArray", column, values })),
    sql: vi.fn(makeSql),
  };
});

const state: { catalog: Record<string, unknown>[]; inventory: Record<string, unknown>[]; balances: Record<string, unknown>[]; locations: Record<string, unknown>[]; audit: Record<string, unknown>[]; snapshots: Record<string, unknown>[]; executeRowsObject: boolean; failBalanceInsertAt: number | null; balanceInsertAttempts: number } = { catalog: [], inventory: [], balances: [], locations: [{ id: 1, tenantId: 1, name: "Box 1", isActive: true }, { id: 2, tenantId: 1, name: "Box 2", isActive: true }, { id: 3, tenantId: 1, name: "Storefront", isActive: true }, { id: 4, tenantId: 1, name: "Backstock", isActive: true }], audit: [], snapshots: [], executeRowsObject: false, failBalanceInsertAt: null, balanceInsertAttempts: 0 };


vi.mock("@workspace/db", () => {
  const col = (name: string) => name;
  const catalogItemsTable = { _name: "catalog_items", id: col("id"), tenantId: col("tenantId"), sku: col("sku"), merchantSku: col("merchantSku"), alavontId: col("alavontId"), catalogItemId: col("catalogItemId") };
  const inventoryTemplatesTable = { _name: "inventory_templates", id: col("id"), tenantId: col("tenantId"), catalogItemId: col("catalogItemId") };
  const inventoryLocationsTable = { _name: "inventory_locations", id: col("id"), tenantId: col("tenantId"), name: col("name"), isActive: col("isActive") };
  const inventoryBalancesTable = { _name: "inventory_balances", id: col("id"), tenantId: col("tenantId"), productId: col("productId"), locationId: col("locationId"), quantityOnHand: col("quantityOnHand") };
  const auditLogsTable = { _name: "audit_logs" };
  const extractFilters = (cond: unknown): Array<{ column: string; value: unknown }> => {
    if (!cond || typeof cond !== "object") return [];
    const c = cond as { op?: string; args?: unknown[]; column?: string; value?: unknown };
    if (c.op === "eq" && typeof c.column === "string") return [{ column: c.column, value: c.value }];
    if (c.op === "and") return (c.args ?? []).flatMap(extractFilters);
    return [];
  };
  const query = (rows: Record<string, unknown>[]) => ({
    where: (cond?: unknown) => {
      const filters = extractFilters(cond);
      return query(filters.length ? rows.filter(row => filters.every(f => row[f.column] === f.value)) : rows);
    },
    limit: () => Promise.resolve(rows.slice(0, 1)),
    then: (resolve: (v: unknown) => void) => resolve(rows),
  });
  const tableRows = (table: { _name?: string } | undefined, selection?: unknown) => {
    if (table?._name === "catalog_items") return selection ? state.catalog.map(r => ({ id: r.id, sku: r.sku, name: r.name, safeName: r.safeName, luciferCruzName: r.luciferCruzName, merchantName: r.merchantName, customerSafeName: r.customerSafeName, alavontName: r.alavontName, alavontId: r.alavontId, merchantSku: r.merchantSku, tenantId: r.tenantId })) : state.catalog;
    if (table?._name === "inventory_templates") return selection ? state.inventory.map(r => ({ id: r.id, tenantId: r.tenantId, catalogItemId: r.catalogItemId })) : state.inventory;
    if (table?._name === "inventory_locations") return state.locations;
    if (table?._name === "inventory_balances") return selection ? state.balances.map(r => ({ id: r.id, tenantId: r.tenantId, productId: r.productId, locationId: r.locationId })) : state.balances;
    return [];
  };
  return { db: {
    select: vi.fn((selection?: unknown) => ({ from: (table: { _name?: string }) => query(tableRows(table, selection)) })),
    insert: vi.fn((table: { _name?: string }) => ({ values: (vals: Record<string, unknown>) => {
      const row = { id: table._name === "catalog_items" ? state.catalog.length + 1 : table._name === "inventory_balances" ? state.balances.length + 1 : state.inventory.length + 1, ...vals };
      if (table._name === "catalog_items") state.catalog.push(row);
      if (table._name === "inventory_templates") state.inventory.push(row);
      if (table._name === "inventory_balances") {
        state.balanceInsertAttempts += 1;
        if (state.failBalanceInsertAt === state.balanceInsertAttempts) throw new Error("simulated balance insert failure");
        state.balances.push(row);
      }
      if (table._name === "audit_logs") state.audit.push(row);
      return { returning: () => Promise.resolve([row]), then: (resolve: (v: unknown) => void) => resolve(undefined) };
    } })),
    update: vi.fn((table: { _name?: string }) => ({ set: (vals: Record<string, unknown>) => ({ where: (cond?: unknown) => {
      const rows = table._name === "catalog_items" ? state.catalog : table._name === "inventory_templates" ? state.inventory : table._name === "inventory_balances" ? state.balances : [];
      const filters = extractFilters(cond);
      for (const row of rows) if (!filters.length || filters.every(f => row[f.column] === f.value)) Object.assign(row, vals);
      return Promise.resolve();
    } }) })),
    delete: vi.fn((table: { _name?: string }) => ({ where: () => { if (table._name === "catalog_items") state.catalog = []; if (table._name === "inventory_templates") state.inventory = []; return Promise.resolve(); } })),
    execute: vi.fn((q: unknown) => {
      const text = String(q);
      const wrap = (rows: Record<string, unknown>[]) => state.executeRowsObject ? { rows } : rows;
      if (text.includes("SELECT id, snapshot")) return Promise.resolve(wrap(state.snapshots));
      if (text.includes("INSERT INTO catalog_import_snapshots")) return Promise.resolve(wrap([{ id: 1 }]));
      return Promise.resolve(wrap([]));
    }),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const before = { catalog: [...state.catalog], inventory: [...state.inventory], balances: [...state.balances], audit: [...state.audit] };
      try { return await fn((await import("@workspace/db")).db); }
      catch (e) { state.catalog = before.catalog; state.inventory = before.inventory; state.balances = before.balances; state.audit = before.audit; throw e; }
    }),
  }, catalogItemsTable, inventoryTemplatesTable, inventoryLocationsTable, inventoryBalancesTable, auditLogsTable };
});

const importRouter = (await import("../import")).default;
function buildApp() { const app = express(); app.use(express.json()); app.use("/api", importRouter); return app; }
const headers = "Regular Price,Sale Price,Active Sale,Alavont Category,Alavont Name,Alavont Image,Alavont Description,Alavont SKU,Safe Category,Safe Name,Safe Image,Safe Description,Box 1 Inventory,Box 2 Inventory,Storefront Inventory,Backstock Inventory,Box 1 PAR,Box 2 PAR,Storefront PAR,Backstock PAR";
const goodCsv = `${headers}\n12.50,9.99,true,Cat,Name,https://example.com/a.jpg,Desc,SKU-1,Safe cat,Safe,https://example.com/s.jpg,Safe desc,1,2,3,9,2,2,3,9\n`;
const oldHeaders = "sku,name,description,category,brand,price,unit,quantity_size,active,image_url,safe_name,safe_description,safe_category,safe_image_url,inventory_location,current_inventory,par_level,reorder_threshold,sort_order";
const oldCsv = `${oldHeaders}\nSKU-OLD,Old Name,Desc,Cat,alavont,12.50,ml,10,true,https://example.com/a.jpg,Safe,Safe desc,Safe cat,https://example.com/s.jpg,Back,9,3,2,1\n`;

beforeEach(() => { vi.clearAllMocks(); state.catalog = []; state.inventory = []; state.balances = []; state.audit = []; state.snapshots = []; state.executeRowsObject = false; state.failBalanceInsertAt = null; state.balanceInsertAttempts = 0; });

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
  it("imports a new catalog product in a transaction when confirmed", async () => {
    const res = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from(goodCsv), "catalog.csv");
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    expect(state.catalog[0]).toMatchObject({ tenantId: 1, sku: "SKU-1", price: "9.99", regularPrice: "12.50" });
    expect(state.balances).toHaveLength(0);
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

  it("supports the Product Master import compatibility endpoint without redirecting multipart uploads", async () => {
    const res = await supertest(buildApp()).post("/api/admin/import/product-master?confirm=true").attach("file", Buffer.from(goodCsv), "catalog.csv");

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    expect(res.body.updated).toBe(0);
    expect(state.balances).toHaveLength(0);
  });

  it("imports 30+ SKUs without tuple-expanded ANY SQL", async () => {
    state.executeRowsObject = true;
    const rows = Array.from({ length: 35 }, (_, i) => [
      "10.00", "8.00", "true", "Cat", `Name ${i}`, "https://example.com/a.jpg", "Desc", `SKU-${i}`,
      "Safe Cat", `Safe ${i}`, "https://example.com/s.jpg", "Safe Desc", "1", "2", "3", "4", "1", "2", "3", "4",
    ].join(","));
    const res = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from(`${headers}\n${rows.join("\n")}\n`), "Alavont-N-Safe-Full-Inventory-import.csv");

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(35);
    expect(state.catalog).toHaveLength(35);
    expect(state.catalog.every(item => Number(item.stockQuantity) === 10 && Number(item.inventoryAmount) === 10)).toBe(true);
    expect(state.balances).toHaveLength(0);
    const sqlTexts = vi.mocked(sql).mock.calls.map(([strings]) => Array.from(strings as TemplateStringsArray).join(""));
    expect(sqlTexts.some(text => /ANY\s*\(\s*\(/i.test(text))).toBe(false);
    expect(sqlTexts.some(text => /sku.*ANY/i.test(text))).toBe(false);
  });


  it("does not create inventory rows during confirmed catalog import", async () => {
    const res = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from(goodCsv), "catalog.csv");

    expect(res.status).toBe(200);
    expect(state.catalog).toHaveLength(1);
    expect(state.inventory).toHaveLength(0);
    expect(state.balances).toHaveLength(0);
  });

  it("blocks imports when the upload contains duplicate SKUs and returns structured row diagnostics", async () => {
    const csv = `${headers}
10.00,,false,Cat,One,https://example.com/a.jpg,Desc,SKU-DUP,Safe Cat,Safe One,https://example.com/s.jpg,Safe Desc,1,0,0,0,1,0,0,0
11.00,,false,Cat,Two,https://example.com/a.jpg,Desc,SKU-DUP,Safe Cat,Safe Two,https://example.com/s.jpg,Safe Desc,2,0,0,0,2,0,0,0
`;
    const res = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from(csv), "duplicates.csv");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Uploaded spreadsheet contains duplicate products.");
    expect(res.body.duplicateWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "upload_duplicate_sku", key: "sku-dup", rows: [2, 3], sku: "SKU-DUP", name: "One" }),
    ]));
    expect(res.body.preview[0].duplicateWarnings).toEqual(expect.arrayContaining([expect.objectContaining({ type: "upload_duplicate_sku", rows: [2, 3] })]));
    const { logger } = await import("../../lib/logger");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 1, count: expect.any(Number), first10Warnings: expect.any(Array) }), "import_duplicate_block");
    expect(state.catalog).toHaveLength(0);
  });

  it("leaves unrelated existing duplicates untouched while inserting new products", async () => {
    state.executeRowsObject = true;
    state.catalog.push({ id: 1, tenantId: 1, sku: "DUP-A", name: "Duplicate Product", alavontName: "Duplicate Product" });
    state.catalog.push({ id: 2, tenantId: 1, sku: "DUP-B", name: "Duplicate Product", alavontName: "Duplicate Product" });
    state.balances.push({ id: 1, tenantId: 1, productId: 2, locationId: 1, quantityOnHand: "5.000" });
    const rows = Array.from({ length: 35 }, (_, i) => [
      "10.00", "8.00", "true", "Cat", `Fresh Product ${i}`, "https://example.com/a.jpg", "Desc", `FRESH-${i}`,
      "Safe Cat", `Safe Fresh ${i}`, "https://example.com/s.jpg", "Safe Desc", "1", "2", "3", "4", "1", "2", "3", "4",
    ].join(","));

    const res = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from(`${headers}\n${rows.join("\n")}\n`), "Alavont-N-Safe-Full-Inventory-import.csv");

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(35);
    expect(state.catalog.filter(item => item.name === "Duplicate Product")).toHaveLength(2);
    expect(state.balances).toEqual([expect.objectContaining({ productId: 2, quantityOnHand: "5.000" })]);
    expect(state.catalog).toHaveLength(37);
  });

  it("does not repair unrelated duplicates and still inserts an unrelated product", async () => {
    state.catalog.push({ id: 1, tenantId: 1, sku: "A", name: "Red Brick", alavontName: "Red Brick" });
    state.catalog.push({ id: 2, tenantId: 1, sku: "B", name: "Red Brick", alavontName: "Red Brick" });
    const csv = `${headers}
10.00,,false,Cat,Unique,https://example.com/a.jpg,Desc,SKU-UNIQUE,Safe Cat,Safe,https://example.com/s.jpg,Safe Desc,0,0,0,0,0,0,0,0
`;
    const res = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from(csv), "catalog.csv");

    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    expect(state.catalog.filter(item => item.name === "Red Brick")).toHaveLength(2);
    expect(state.catalog).toEqual(expect.arrayContaining([expect.objectContaining({ sku: "SKU-UNIQUE", name: "Unique" })]));
  });

  it("does not query existing catalog rows when no valid SKU values were prepared", async () => {
    const csv = `${headers}\n10.00,,false,Cat,Missing Sku,https://example.com/a.jpg,Desc,,Safe Cat,Safe,https://example.com/s.jpg,Safe Desc,0,0,0,0\n`;
    const res = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from(csv), "missing-sku.csv");

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Alavont SKU is required" })]));
    expect(vi.mocked(inArray).mock.calls.some(([column]) => column === "sku")).toBe(false);
  });

  it("uploading the same file twice updates the original product row and preserves inventory references", async () => {
    const first = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from(goodCsv), "catalog.csv");
    expect(first.status).toBe(200);
    const productCount = state.catalog.length;
    const inventoryRowCount = state.balances.length;
    const secondCsv = `${headers}\n12.50,10.99,true,Cat,Name,https://example.com/a.jpg,Desc,SKU-1,Safe cat,Safe,https://example.com/s.jpg,Safe desc,7,2,3,9,4,2,3,9\n`;
    const second = await supertest(buildApp()).post("/api/admin/products/import?confirm=true").attach("file", Buffer.from(secondCsv), "catalog.csv");

    expect(second.status).toBe(200);
    expect(second.body.updated).toBe(1);
    expect(state.catalog).toHaveLength(productCount);
    expect(state.balances).toHaveLength(inventoryRowCount);
    expect(state.catalog[0]).toMatchObject({ id: 1, sku: "SKU-1", price: "10.99" });
    expect(state.catalog[0]).toMatchObject({ safeName: "Safe", safeDescription: "Safe desc", safeCategory: "Safe cat", stockQuantity: "21.00", inventoryAmount: "21.00" });
    expect(state.balances).toHaveLength(inventoryRowCount);
  });

  it("dry-run preview matches changed SKU by normalized product name", async () => {
    state.catalog.push({ id: 6, tenantId: 1, sku: "RB-1", name: "Red Brick", alavontName: "Red Brick" });
    const csv = `${headers}\n10.00,,false,Cat,Red Brick,https://example.com/a.jpg,Desc,RB-NEW,Safe Cat,Safe,https://example.com/s.jpg,Safe Desc,1,0,0,0,5,0,0,0\n`;
    const res = await supertest(buildApp()).post("/api/admin/products/import?dryRun=true").attach("file", Buffer.from(csv), "preview.csv");

    expect(res.status).toBe(200);
    expect(res.body.preview[0]).toMatchObject({ oldProductId: 6, matchedProductId: 6, sku: "RB-NEW", name: "Red Brick", parValues: { "Box 1": 5 } });
  });

  it("parse-headers accepts the provided Alavont/Safe spreadsheet headers and aliases", async () => {
    const uploadHeaders = [
      "Regular Price", "Sale Price", "Active Sale", "Alavont  Category", "Alavont Name",
      "Alavont Image", "Alavontb Description", "Alavont  ID", "Safe Category", "Safe Name",
      "Safe Image", "Safe Description", "Box 1 Inventory", "Box 2 Inventory", "Storefront Quantity", "Backstock Inventory", "Box 1 PAR", "Box 2 PAR", "Storefront PAR", "Backstock PAR",
    ].join(",");
    const row = ["10", "8", "true", "Cat", "Name", "https://example.com/a.jpg", "Desc", "SKU-A", "Safe Cat", "Safe Name", "https://example.com/s.jpg", "Safe Desc", "1", "2", "3", "4", "1", "2", "3", "4"].join(",");
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
