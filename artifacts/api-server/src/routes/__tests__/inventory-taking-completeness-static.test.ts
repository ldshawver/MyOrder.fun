import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const inventoryRoute = readFileSync(resolve(root, "artifacts/api-server/src/routes/inventory.ts"), "utf8");
const inventoryProjection = readFileSync(resolve(root, "artifacts/api-server/src/lib/inventoryBalances.ts"), "utf8");
const shiftsRoute = readFileSync(resolve(root, "artifacts/api-server/src/routes/shifts.ts"), "utf8");
const inventoryPage = readFileSync(resolve(root, "artifacts/platform/src/pages/admin/inventory.tsx"), "utf8");

describe("inventory-taking completeness safeguards", () => {
  it("does not category- or product-name-filter local physical counts", () => {
    expect(inventoryPage).not.toContain("EXCLUDE_CATEGORIES");
    expect(shiftsRoute).not.toContain("CSR_INVENTORY_EXCLUDED_NAMES");
    expect(shiftsRoute).not.toMatch(/LOWER\(COALESCE\([^)]*category/i);
  });

  it("keeps missing balances explicit rather than seeding or coercing them to zero", () => {
    expect(inventoryProjection).not.toMatch(/EXISTS \(\s*SELECT 1 FROM inventory_balances ib/);
    expect(inventoryProjection).toContain("qty: b ? parseFloat(String(b.quantityOnHand)) : null");
    expect(inventoryProjection).toContain("hasBalance: Boolean(b)");
    expect(inventoryPage).toContain("Not counted");
    expect(inventoryPage).toContain("Inventoried:");
  });

  it("uses permission-gated immutable ledger commands for opening counts", () => {
    expect(inventoryRoute).toContain('router.post("/admin/inventory/opening-counts", requirePermission("inventory.manage")');
    expect(inventoryRoute).toContain("postCatalogOpeningCount");
    expect(inventoryPage).toContain("/api/admin/inventory/opening-counts");
    expect(inventoryPage).not.toContain("EXCLUDE_CATEGORIES.includes");
  });
});
