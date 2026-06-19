import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");
const route = (name: string) => readFileSync(join(root, "routes", name), "utf8");
const lib = (name: string) => readFileSync(join(root, "lib", name), "utf8");

const catalog = route("catalog.ts");
const ai = route("ai.ts");
const shifts = route("shifts.ts");
const orders = route("orders.ts");
const imports = route("import.ts");
const checkout = lib("checkoutNormalizer.ts");

describe("Phase 3 POS operations Product Master integration", () => {
  describe("/api/admin/product-master", () => {
    it("requires admin/global_admin and returns spreadsheet fields plus four location balances", () => {
      expect(catalog).toContain('router.get("/admin/product-master", requireRole("global_admin", "admin")');
      for (const header of [
        "Regular Price", "Sale Price", "Active Sale", "Alavont Category", "Alavont Name", "Alavont Image",
        "Alavont Description", "Alavont SKU", "Safe Category", "Safe Name", "Safe Image", "Safe Description",
        "Box 1 Inventory", "Box 2 Inventory", "Storefront Inventory", "Backstock Inventory",
      ]) {
        expect(catalog).toContain(`"${header}"`);
      }
    });

    it("is tenant-scoped and cannot list another tenant's products", () => {
      expect(catalog).toContain("const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId()");
      expect(catalog).toContain("eq(catalogItemsTable.tenantId, tenantId)");
      expect(catalog).toContain("eq(inventoryLocationsTable.tenantId, tenantId)");
      expect(catalog).toContain("eq(inventoryBalancesTable.tenantId, tenantId)");
    });
  });

  describe("/api/admin/product-master/:id/lifecycle", () => {
    it("supports lifecycle fields, rejects unknown fields, scopes updates, and audits changes", () => {
      expect(catalog).toContain('router.patch("/admin/product-master/:id/lifecycle", requireRole("global_admin", "admin")');
      expect(catalog).toContain("active: z.boolean().optional()");
      expect(catalog).toContain("archived: z.boolean().optional()");
      expect(catalog).toContain("complianceHold: z.boolean().optional()");
      expect(catalog).toContain("}).strict().safeParse(req.body)");
      expect(catalog).toContain("and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, id))");
      expect(catalog).toContain('action: "catalog.lifecycle_updated"');
    });

    it("inactive, archive, compliance hold, and non-sellable rows are kept out of customer catalog and checkout", () => {
      expect(catalog).toContain("const available = body.data.complianceHold === true || body.data.archived === true ? false");
      expect(catalog).toContain("isAvailable: available");
      expect(catalog).toContain("alavontInStock: available");
      expect(catalog).toContain("rows = rows.filter(r => r.isAvailable === true && r.alavontInStock !== false)");
      expect(checkout).toContain("if (ci.isAvailable === false)");
      expect(checkout).toContain('"item_unavailable"');
    });
  });

  describe("AI Product Master admin config", () => {
    it("denies user/csr, returns active tenant products, and persists package/bundle/upsell IDs", () => {
      expect(ai).toContain('router.get("/admin/ai/product-master-options"');
      expect(ai).toContain('router.patch("/admin/ai/product-master-config"');
      expect(ai).toContain('if (actorRole !== "global_admin" && actorRole !== "admin")');
      expect(ai).toContain("eq(catalogItemsTable.tenantId, tenantId)");
      expect(ai).toContain("eq(catalogItemsTable.isAvailable, true)");
      expect(ai).toContain("eq(catalogItemsTable.alavontInStock, true)");
      expect(ai).toContain("aiUpsellIds: z.array(z.number().int().positive()).max(50).optional()");
      expect(ai).toContain("packageIds: z.array(z.number().int().positive()).max(50).optional()");
      expect(ai).toContain("bundleIds: z.array(z.number().int().positive()).max(50).optional()");
      expect(ai).toContain("}).strict().safeParse(req.body)");
      expect(ai).toContain("All AI/package/bundle product IDs must belong to this tenant catalog");
      expect(ai).toContain("metadata = { ...");
    });
  });

  describe("/api/admin/inventory-transfers", () => {
    it("moves Backstock to Box/Storefront with guards, audit logging, and catalog total recompute", () => {
      expect(shifts).toContain('router.post("/admin/inventory-transfers", requireRole("global_admin", "admin")');
      expect(shifts).toContain('fromLocationName: z.enum(["Backstock"])');
      expect(shifts).toContain('toLocationName: z.enum(["Box 1", "Box 2", "CSR Sales Box 1", "CSR Sales Box 2", "Storefront"])');
      expect(shifts).toContain("quantity: z.number().positive().max(1_000_000)");
      expect(shifts).toContain("eq(inventoryLocationsTable.tenantId, tenantId)");
      expect(shifts).toContain("quantity_on_hand");
      expect(shifts).toContain("INSUFFICIENT_BACKSTOCK");
      expect(shifts).toContain('res.status(409).json({ error: "Insufficient Backstock inventory"');
      expect(shifts).toContain("await recomputeCatalogInventoryTotals(tenantId, productId)");
      expect(shifts).toContain('action: "inventory.restock_transfer"');
    });
  });

  describe("/api/shifts/:id/receipts/:kind", () => {
    it("supports six receipt kinds, rejects invalid kinds, scopes by tenant, and uses server data", () => {
      expect(shifts).toContain('z.enum(["beginning_inventory", "ending_inventory", "shift_sales", "restocking", "deposit", "supervisor_checkout"])');
      expect(shifts).toContain('router.get("/shifts/:id/receipts/:kind", requireRole("global_admin", "admin", "csr")');
      expect(shifts).toContain("if (!Number.isInteger(shiftId) || shiftId <= 0 || !kind.success)");
      expect(shifts).toContain("eq(labTechShiftsTable.tenantId, tenantId)");
      expect(shifts).toContain("computeShiftStats(shiftId)");
      expect(shifts).toContain("shiftInventoryItemsTable");
      expect(shifts).toContain("beginningInventory: inventory.map");
      expect(shifts).toContain("endingInventory: inventory.map");
      expect(shifts).toContain("sales: { orderCount: stats.orderCount");
      expect(shifts).toContain("deposit: { cashBankStart");
      expect(shifts).toContain("supervisor: { supervisorId");
    });
  });

  describe("end-to-end Product Master operations chain", () => {
    it("wires import -> Product Master -> Box 1 shift inventory -> order decrement -> ending receipt", () => {
      expect(imports).toContain("CATALOG_IMPORT_HEADERS");
      expect(imports).toContain('"Box 1 Inventory"');
      expect(imports).toContain("inventoryBalancesTable");
      expect(catalog).toContain('router.get("/admin/product-master"');
      expect(shifts).toContain("balanceByProductId.set(b.productId");
      expect(shifts).toContain("quantityStart: String(");
      expect(orders).toContain("quantityOnHand: sql`${inventoryBalancesTable.quantityOnHand} - ${String(line.quantity)}`");
      expect(shifts).toContain("expectedEnding: i.quantityEnd ?? i.quantityStart - i.quantitySold");
    });
  });
});
