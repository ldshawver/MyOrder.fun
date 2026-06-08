/**
 * Tests for /api/admin/products/import — Task #10 (14-column menu import).
 *
 * Verifies:
 *   - Downloaded template has the canonical headers in the exact spec order.
 *   - A CSV with legacy friendly headers imports cleanly.
 *   - A reordered (column-shuffled) CSV is accepted.
 *   - A BOM-prefixed CSV is accepted.
 *   - A TSV with the same 14 headers is accepted.
 *   - A CSV missing a required column returns JSON 400 naming the column.
 *   - A CSV with an unexpected extra column is rejected.
 */
import express from "express";
import supertest from "supertest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(() => ({ userId: "user-clerk-id" })),
}));

vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  loadDbUser: (req: { dbUser?: unknown }, _res: unknown, next: () => void) => {
    req.dbUser = { id: 1, role: "admin", status: "approved", email: "a@b.com", clerkId: "user-clerk-id" };
    next();
  },
  requireDbUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApproved: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/singleTenant", () => ({
  getHouseTenantId: vi.fn(async () => 1),
}));

// Track inserts/updates for assertions
const state: {
  inserted: Record<string, unknown>[];
  updated: Record<string, unknown>[];
  inventoryTemplates: Record<string, unknown>[];
} = {
  inserted: [],
  updated: [],
  inventoryTemplates: [],
};

vi.mock("@workspace/db", () => {
  const adminSettingsTable = { _name: "admin_settings" };
  const catalogItemsTable = {
    _name: "catalog_items",
    id: "id",
    tenantId: "tenantId",
    sku: "sku",
    externalMenuId: "externalMenuId",
    isWooManaged: "isWooManaged",
    isLocalAlavont: "isLocalAlavont",
  };
  const inventoryTemplatesTable = {
    _name: "inventory_templates",
    id: "templateId",
    tenantId: "templateTenantId",
    catalogItemId: "templateCatalogItemId",
    alavontId: "templateAlavontId",
    displayOrder: "templateDisplayOrder",
  };
  const mkChain = (selection?: unknown) => {
    const getRows = () => {
      if (chain._table === adminSettingsTable) return [{ id: 1, tenantId: 1, importTemplateSpec: null }];
      if (chain._table === catalogItemsTable && selection === undefined) {
        return state.inserted.map((row, index) => ({ id: index + 1, ...row }));
      }
      if (chain._table === inventoryTemplatesTable) return state.inventoryTemplates;
      return [];
    };
    const chain: Record<string, unknown> & { _table?: unknown } = {};
    chain.from = vi.fn((table: unknown) => {
      chain._table = table;
      return chain;
    });
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => Promise.resolve(getRows()));
    chain.limit = vi.fn(() => Promise.resolve(getRows()));
    chain.then = vi.fn((resolve: (value: unknown) => void) => resolve(getRows()));
    return chain;
  };
  return {
    db: {
      execute: vi.fn(() => Promise.resolve()),
      select: vi.fn((selection?: unknown) => mkChain(selection)),
      insert: vi.fn((table: { _name?: string }) => ({
        values: (vals: Record<string, unknown>) => {
          if (table._name === "catalog_items") state.inserted.push(vals);
          if (table._name === "inventory_templates") state.inventoryTemplates.push(vals);
          return {
            returning: () => Promise.resolve([vals]),
            then: (resolve: (value: unknown) => void) => resolve(undefined),
          };
        },
      })),
      update: vi.fn((table: { _name?: string }) => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => {
            if (table._name === "catalog_items") state.updated.push(vals);
            return Promise.resolve();
          },
        }),
      })),
    },
    adminSettingsTable,
    catalogItemsTable,
    inventoryTemplatesTable,
    auditLogsTable: { id: "id" },
  };
});

const importRouter = (await import("../import")).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", importRouter);
  return app;
}

const fixture = (name: string): Buffer =>
  fs.readFileSync(path.join(__dirname, "fixtures", name));

beforeEach(() => {
  state.inserted = [];
  state.updated = [];
  state.inventoryTemplates = [];
});

describe("menu import — Alavont canonical import spec", () => {
  it("template has the canonical headers in spec order", async () => {
    const res = await supertest(buildApp()).get("/api/admin/products/import-template");
    expect(res.status).toBe(200);
    const headerLine = res.text.split("\n")[0];
    expect(headerLine).toBe([
      "regular_price",
      "alavont_image",
      "alavont_name",
      "alavont_desc",
      "alavont_category",
      "alavont_in_stock",
      "alavont_id",
      "Quantity",
      "Unit",
      "Sale_price",
      "lucifer_cruz_name",
      "lucifer_cruz_image",
      "lucifer_cruz_desc",
      "lucifer_cruz_category",
      "lucifer_cruz_Inventory",
    ].join(","));
  });

  it("imports a legacy friendly-header CSV cleanly", async () => {
    const res = await supertest(buildApp())
      .post("/api/admin/products/import")
      .attach("file", fixture("menu-import-14col.csv"), "menu.csv");

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.inserted).toBe(2);
    expect(res.body.updated).toBe(0);
    expect(state.inserted).toHaveLength(2);
    // Verify field mapping — Menu In Stock truthy values
    expect(state.inserted[0].isAvailable).toBe(true);
    expect(state.inserted[1].isAvailable).toBe(true);
    // Verify spec field mappings
    expect(state.inserted[0].name).toBe("Midnight Recovery");
    expect(state.inserted[0].sku).toBe("SKU-001");
    expect(state.inserted[0].externalMenuId).toBe("ALV-001");
    expect(state.inserted[0].merchantName).toBe("Velvet Restore");
    expect(state.inserted[0].unitMeasurement).toBe("ml");
  });

  it("imports a canonical-header CSV with optional Sale_price cleanly", async () => {
    const csv =
      "regular_price,alavont_image,alavont_name,alavont_desc,alavont_category,alavont_in_stock,alavont_id,Quantity,Unit,Sale_price,lucifer_cruz_name,lucifer_cruz_image,lucifer_cruz_desc,lucifer_cruz_category,lucifer_cruz_Inventory\n" +
      "29.99,https://example.com/a.jpg,Canonical Item,Safe desc,Category,true,ALV-CAN-1,5,ml,24.99,LC Canonical,https://example.com/lc.jpg,Merchant desc,LC Category,LC-CAN-1\n";
    const res = await supertest(buildApp())
      .post("/api/admin/products/import")
      .attach("file", Buffer.from(csv), "canonical-menu.csv");

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.inserted).toBe(1);
    expect(state.inserted[0].name).toBe("Canonical Item");
    expect(state.inserted[0].sku).toBe("LC-CAN-1");
    expect(state.inserted[0].merchantName).toBe("LC Canonical");
  });

  it("returns JSON 400 with the missing column name", async () => {
    const res = await supertest(buildApp())
      .post("/api/admin/products/import")
      .attach("file", fixture("menu-import-missing.csv"), "menu.csv");

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body.missingColumns).toContain("lucifer_cruz_Inventory");
    expect(res.body.error).toMatch(/lucifer_cruz_Inventory/);
  });

  it("accepts a CSV with reordered columns", async () => {
    const res = await supertest(buildApp())
      .post("/api/admin/products/import")
      .attach("file", fixture("menu-import-reordered.csv"), "menu.csv");

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.inserted).toBe(1);
    expect(state.inserted[0].name).toBe("Reordered Item");
    expect(state.inserted[0].sku).toBe("SKU-100");
  });

  it("accepts a BOM-prefixed CSV", async () => {
    const csv = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      fixture("menu-import-14col.csv"),
    ]);
    const res = await supertest(buildApp())
      .post("/api/admin/products/import")
      .attach("file", csv, "menu.csv");

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.inserted).toBe(2);
  });

  it("accepts a TSV with the same 14 headers", async () => {
    const csvText = fixture("menu-import-14col.csv").toString("utf-8");
    // Convert to TSV (only the body has no embedded commas in our fixture)
    const tsvText = csvText.replace(/,/g, "\t");
    const res = await supertest(buildApp())
      .post("/api/admin/products/import")
      .attach("file", Buffer.from(tsvText), "menu.tsv");

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.inserted).toBe(2);
  });

  it("rejects a CSV with an unexpected extra column", async () => {
    const csv =
      "Menu Regular Price,Menu Image,Menu Name,Menu Description,Menu Category,Menu In Stock,Menu ID,Amount,Unit Measurement,Merchant Name,Merchant Image,Merchant Description,Merchant Category,Merchant Sku,Bogus\n" +
      "1,a,n,d,c,true,e,1,u,m,mi,md,mc,s,x\n";
    const res = await supertest(buildApp())
      .post("/api/admin/products/import")
      .attach("file", Buffer.from(csv), "menu.csv");

    expect(res.status).toBe(400);
    expect(res.body.extraColumns).toContain("Bogus");
  });

  it("preserves alavont_image URL on import and maps it to imageUrl and alavontImageUrl", async () => {
    const csv =
      "regular_price,alavont_image,alavont_name,alavont_desc,alavont_category,alavont_in_stock,alavont_id,Quantity,Unit,Sale_price,lucifer_cruz_name,lucifer_cruz_image,lucifer_cruz_desc,lucifer_cruz_category,lucifer_cruz_Inventory\n" +
      "19.99,https://cdn.example.com/product-a.jpg,Image Test Item,Desc,Cat,true,ALV-IMG-1,3,ml,,LC Name,https://cdn.example.com/lc-a.jpg,LC Desc,LC Cat,LC-IMG-1\n";
    const res = await supertest(buildApp())
      .post("/api/admin/products/import")
      .attach("file", Buffer.from(csv), "images.csv");

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.inserted).toBe(1);
    expect(state.inserted[0].imageUrl).toBe("https://cdn.example.com/product-a.jpg");
    expect(state.inserted[0].alavontImageUrl).toBe("https://cdn.example.com/product-a.jpg");
    expect(state.inserted[0].luciferCruzImageUrl).toBe("https://cdn.example.com/lc-a.jpg");
  });

  it("discards alavont_image when value is not a valid URL", async () => {
    const csv =
      "regular_price,alavont_image,alavont_name,alavont_desc,alavont_category,alavont_in_stock,alavont_id,Quantity,Unit,Sale_price,lucifer_cruz_name,lucifer_cruz_image,lucifer_cruz_desc,lucifer_cruz_category,lucifer_cruz_Inventory\n" +
      "9.99,not-a-url,Bad Image Item,Desc,Cat,true,ALV-IMG-2,1,ml,,LC Name,,LC Desc,LC Cat,LC-IMG-2\n";
    const res = await supertest(buildApp())
      .post("/api/admin/products/import")
      .attach("file", Buffer.from(csv), "bad-image.csv");

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.inserted).toBe(1);
    expect(state.inserted[0].imageUrl).toBeNull();
    expect(state.inserted[0].alavontImageUrl).toBeNull();
  });

  it("stores null imageUrl when alavont_image column is empty", async () => {
    const csv =
      "regular_price,alavont_image,alavont_name,alavont_desc,alavont_category,alavont_in_stock,alavont_id,Quantity,Unit,Sale_price,lucifer_cruz_name,lucifer_cruz_image,lucifer_cruz_desc,lucifer_cruz_category,lucifer_cruz_Inventory\n" +
      "14.99,,No Image Item,Desc,Cat,true,ALV-IMG-3,2,ml,,LC Name,,LC Desc,LC Cat,LC-IMG-3\n";
    const res = await supertest(buildApp())
      .post("/api/admin/products/import")
      .attach("file", Buffer.from(csv), "empty-image.csv");

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.inserted).toBe(1);
    expect(state.inserted[0].imageUrl).toBeNull();
    expect(state.inserted[0].alavontImageUrl).toBeNull();
  });

  it("response shape matches { inserted, updated, skipped, errors:[{row,message}] }", async () => {
    // Bad row — missing required Menu Name (after a valid header set)
    const csv =
      "Menu Regular Price,Menu Image,Menu Name,Menu Description,Menu Category,Menu In Stock,Menu ID,Amount,Unit Measurement,Merchant Name,Merchant Image,Merchant Description,Merchant Category,Merchant Sku\n" +
      ",,,,,true,,,,,,,,SKU-X\n";
    const res = await supertest(buildApp())
      .post("/api/admin/products/import")
      .attach("file", Buffer.from(csv), "menu.csv");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("inserted");
    expect(res.body).toHaveProperty("updated");
    expect(res.body).toHaveProperty("skipped");
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors[0]).toMatchObject({ row: 2, message: expect.stringMatching(/Menu Name/) });
  });
});
