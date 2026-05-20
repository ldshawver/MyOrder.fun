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
const state: { inserted: Record<string, unknown>[]; updated: Record<string, unknown>[] } = {
  inserted: [],
  updated: [],
};

vi.mock("@workspace/db", () => {
  const adminSettingsTable = { _name: "admin_settings" };
  const mkChain = () => {
    const chain: Record<string, unknown> & { _table?: unknown } = {};
    chain.from = vi.fn((table: unknown) => {
      chain._table = table;
      return chain;
    });
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve(chain._table === adminSettingsTable ? [{ id: 1, tenantId: 1, importTemplateSpec: null }] : []));
    return chain;
  };
  return {
    db: {
      select: vi.fn(() => mkChain()),
      insert: vi.fn((table: { _name?: string }) => ({
        values: (vals: Record<string, unknown>) => {
          if (table === catalogItemsTable) state.inserted.push(vals);
          return {
            returning: () => Promise.resolve([vals]),
            then: (resolve: (value: unknown) => void) => resolve(undefined),
          };
        },
      })),
      update: vi.fn(() => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => {
            state.updated.push(vals);
            return Promise.resolve();
          },
        }),
      })),
    },
    adminSettingsTable,
    catalogItemsTable: { id: "id", tenantId: "tenantId", sku: "sku", externalMenuId: "externalMenuId" },
    auditLogsTable: { id: "id" },
  };
});

// Reference must come after the mock above
const { catalogItemsTable } = await import("@workspace/db");

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
