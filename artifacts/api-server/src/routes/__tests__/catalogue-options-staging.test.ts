import express from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const state = vi.hoisted(() => ({ tenantId: 1, calls: 0, products: [] as Record<string, unknown>[], options: [] as Record<string, unknown>[] }));
vi.mock("../../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  loadDbUser: (req: { dbUser?: unknown }, _res: unknown, next: () => void) => { req.dbUser = { id: 1, role: "customer", tenantId: state.tenantId }; next(); },
  requireDbUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireApproved: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("@workspace/db", () => ({ db: {
  execute: vi.fn(async () => (++state.calls % 2 === 1 ? state.products : state.options)),
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
    const source = readFileSync(new URL("../catalogue-products.ts", import.meta.url), "utf8");
    const customerQuery = source.split('router.get("/catalogue/products"')[1].split('router.get("/admin/catalogue/products"')[0];
    for (const predicate of ["co.tenant_id = ${tenantId}", "co.active = true", "ci.is_available = true", "alavont_in_stock IS DISTINCT FROM false", "archived", "safeOnlyDuplicate", "complianceHold"]) {
      expect(customerQuery).toContain(predicate);
    }
  });
});
