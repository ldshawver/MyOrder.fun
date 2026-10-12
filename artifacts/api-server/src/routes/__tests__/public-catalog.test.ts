import express from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  products: [] as Record<string, unknown>[],
  storefronts: [
    { tenantId: 1, storefrontUrl: "https://myorder.fun/", status: "active" },
    { tenantId: 2, storefrontUrl: "https://store.example.test/", status: "active" },
  ] as Array<{ tenantId: number; storefrontUrl: string | null; status: string }>,
}));

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ kind: "and", parts }),
  eq: (column: string, value: unknown) => ({ kind: "eq", column, value }),
  ne: (column: string, value: unknown) => ({ kind: "ne", column, value }),
  isNotNull: (column: string) => ({ kind: "notNull", column }),
}));
vi.mock("@workspace/db", () => {
  const catalogItemsTable = Object.fromEntries([
    "id", "tenantId", "isWooManaged", "merchantProductSource", "isAvailable", "wooProductId",
    "luciferCruzName", "luciferCruzDescription", "luciferCruzCategory", "luciferCruzImageUrl",
    "name", "description", "category", "imageUrl", "price", "compareAtPrice", "isFeatured", "metadata",
  ].map(key => [key, key]));
  const tenantsTable = { _name: "tenants", id: "id", status: "status" };
  const tenantSettingsTable = { storefrontUrl: "storefrontUrl", tenantId: "tenantId" };
  const matches = (row: Record<string, unknown>, filter: unknown): boolean => {
    const predicate = filter as { kind: string; parts?: unknown[]; column?: string; value?: unknown };
    if (predicate.kind === "and") return predicate.parts!.every(part => matches(row, part));
    if (predicate.kind === "eq") return row[predicate.column!] === predicate.value;
    if (predicate.kind === "ne") return row[predicate.column!] !== predicate.value;
    if (predicate.kind === "notNull") return row[predicate.column!] != null;
    return false;
  };
  const db = {
    select: vi.fn(() => ({
      from: (table: { _name?: string }) => table._name === "tenants"
        ? { leftJoin: async () => fixtures.storefronts }
        : { where: async (filter: unknown) => fixtures.products.filter(row => matches(row, filter)) },
    })),
  };
  return { db, catalogItemsTable, tenantsTable, tenantSettingsTable };
});

const catalogRouter = (await import("../public-catalog")).default;
const app = express();
app.use("/api", catalogRouter);

const product = (id: number, patch: Record<string, unknown> = {}) => ({
  id, tenantId: 1, isWooManaged: true, merchantProductSource: "woo", wooProductId: `wc-${id}`,
  isAvailable: true, name: `Product ${id}`, luciferCruzName: `Lucifer ${id}`,
  description: "Public description", luciferCruzDescription: "Boutique description",
  category: "Fashion", luciferCruzCategory: "Fashion", imageUrl: "https://example.test/image.jpg",
  luciferCruzImageUrl: null, price: "29.00", compareAtPrice: null, isFeatured: false,
  metadata: {}, costBasis: "2.00", merchantSku: "private-sku", inventoryTrackingData: { secret: true },
  ...patch,
});

beforeEach(() => {
  fixtures.products = [];
  fixtures.storefronts = [
    { tenantId: 1, storefrontUrl: "https://myorder.fun/", status: "active" },
    { tenantId: 2, storefrontUrl: "https://store.example.test/", status: "active" },
  ];
});

describe("GET /api/public/catalog", () => {
  it("shows only published Woo products for the exact storefront tenant through a safe schema", async () => {
    fixtures.products = [
      product(1),
      product(2, { tenantId: 2 }),
      product(3, { isWooManaged: false }),
      product(4, { merchantProductSource: "local_mapped" }),
      product(5, { wooProductId: null }),
      product(6, { isAvailable: false }),
      product(7, { metadata: { isVisible: false } }),
      product(8, { metadata: { complianceHold: true } }),
      product(9, { metadata: { archived: true } }),
      product(10, { metadata: { safeOnlyDuplicate: true } }),
    ];
    const response = await supertest(app).get("/api/public/catalog").set("Host", "myorder.fun");
    expect(response.status, response.text).toBe(200);
    expect(response.body.items).toEqual([{
      id: 1, name: "Lucifer 1", description: "Boutique description", category: "Fashion",
      price: 29, compareAtPrice: null, imageUrl: "https://example.test/image.jpg", isFeatured: false,
    }]);
    expect(JSON.stringify(response.body)).not.toMatch(/tenantId|costBasis|merchantSku|inventoryTrackingData|wooProductId/);
  });

  it("limits pages and rejects unknown or spoofed hosts", async () => {
    fixtures.products = Array.from({ length: 30 }, (_, index) => product(index + 1));
    const page = await supertest(app).get("/api/public/catalog?limit=12&page=2").set("Host", "myorder.fun");
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(12);
    expect(page.body.total).toBe(30);
    expect((await supertest(app).get("/api/public/catalog?limit=200").set("Host", "myorder.fun")).status).toBe(400);
    expect((await supertest(app).get("/api/public/catalog").set("Host", "unknown.test").set("X-Forwarded-Host", "myorder.fun")).status).toBe(404);
    expect((await supertest(app).get("/api/public/catalog").set("Host", "store.example.test")).status).toBe(200);
  });

  it("fails closed for ambiguous unconfigured hosts and never seeds a tenant", async () => {
    fixtures.storefronts = fixtures.storefronts.map(row => ({ ...row, storefrontUrl: null }));
    expect((await supertest(app).get("/api/public/catalog").set("Host", "myorder.fun")).status).toBe(404);
    fixtures.storefronts = fixtures.storefronts.slice(0, 1);
    expect((await supertest(app).get("/api/public/catalog").set("Host", "myorder.fun")).status).toBe(200);
  });
});
