import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../..");
const platformRoot = resolve(repoRoot, "artifacts/platform/src");
const apiRoot = resolve(repoRoot, "artifacts/api-server/src");

function src(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}
function platform(path: string): string {
  return readFileSync(resolve(platformRoot, path), "utf8");
}
function api(path: string): string {
  return readFileSync(resolve(apiRoot, path), "utf8");
}

describe("MyOrder.fun navigation and editor consolidation", () => {
  const layout = platform("components/layout.tsx");
  const app = platform("App.tsx");

  it("removes unrelated LUXit/MyPayLink navigation and routes", () => {
    for (const forbidden of ["SMS & Calls", "Phone & SMS", "Document Hub", "Contractor Hub"]) {
      expect(layout).not.toContain(forbidden);
      expect(app).not.toContain(forbidden.replaceAll(" ", ""));
    }
    expect(app).not.toContain('path="/document-hub"');
    expect(app).not.toContain('path="/contractor-hub"');
    expect(app).not.toContain('path="/admin/communications"');
    expect(app).not.toContain('path="/communications"');
  });

  it("uses Settings and one Receipts & Printers nav entry", () => {
    expect(layout).toContain('label: "Settings"');
    const receiptLinks = layout.match(/label:\s*"Receipts & Printers"/g) ?? [];
    expect(receiptLinks.length).toBeGreaterThanOrEqual(1);
    expect(layout).not.toContain('label: "Receipt Templates"');
    expect(layout).not.toContain('label: "Reprint Receipts"');
    expect(layout).not.toContain('label: "WooCommerce"');
    expect(layout).not.toContain('label: "Integrations"');
  });

  it("replaces web-editor Plasmic UI copy with Puck copy", () => {
    const webEditor = platform("pages/admin/web-editor.tsx");
    expect(webEditor).toContain("Puck Web Editor");
    expect(webEditor).toContain("/api/admin/visual-editor");
    expect(webEditor).not.toContain("Plasmic");
    expect(webEditor).not.toContain("plasmic-host");
  });
});

describe("catalog/inventory/par/order source of truth", () => {
  it("inventory balance edits validate schema, check tenant ownership, and recompute catalog totals", () => {
    const inventory = api("routes/inventory.ts");
    expect(inventory).toContain(".strict().safeParse(req.body)");
    expect(inventory).toContain('Catalog product not found for this tenant');
    expect(inventory).toContain('Inventory location not found for this tenant');
    expect(inventory).toContain("recomputeCatalogInventoryTotals(houseTenantId, productId)");
    expect(inventory).toContain("stockQuantity: String(totals?.qty");
    expect(inventory).toContain("inventoryAmount: String(totals?.qty");
    expect(inventory).toContain("parLevel: String(totals?.par");
  });

  it("catalog stock edits mirror into inventory balances instead of trusting catalog totals", () => {
    const catalog = api("routes/catalog.ts");
    expect(catalog).toContain("mirrorCatalogStockToBackstockAndRecompute");
    expect(catalog).toContain("eq(catalogItemsTable.tenantId, houseTenantId)");
    expect(catalog).toContain("quantityOnHand: String(stockQuantity)");
    expect(catalog).toContain("inventoryAmount: String(totals?.qty");
  });

  it("legacy shift inventory balance override rejects unknown fields and is tenant scoped", () => {
    const shifts = api("routes/shifts.ts");
    expect(shifts).toContain(".strict().safeParse(req.body)");
    expect(shifts).toContain("Balance not found for this tenant");
    expect(shifts).toContain("eq(inventoryBalancesTable.tenantId, houseTenantId)");
    expect(shifts).toContain("recomputeCatalogInventoryTotals(houseTenantId, current.productId)");
  });

  it("order creation decrements inventory balances and syncs catalog inventory fields", () => {
    const orders = api("routes/orders.ts");
    expect(orders).toContain("db.transaction");
    expect(orders).toContain("quantityOnHand: sql`${inventoryBalancesTable.quantityOnHand} - ${String(line.quantity)}`");
    expect(orders).toContain("${inventoryBalancesTable.quantityOnHand} >= ${String(line.quantity)}");
    expect(orders).toContain("InsufficientInventoryError");
    expect(orders).toContain("UPDATE catalog_items");
    expect(orders).toContain("stock_quantity = COALESCE");
    expect(orders).toContain("inventory_amount = COALESCE");
    expect(orders).toContain("WHERE tenant_id = ${houseTenantId}");
  });

  it("order creation denies cross-tenant catalog IDs before inventory decrement", () => {
    const orders = api("routes/orders.ts");
    expect(orders).toContain("One or more catalog items were not found for this tenant");
    expect(orders).toContain("inArray(catalogItemsTable.id, normalizedCatalogIds)");
    expect(orders).toContain("eq(catalogItemsTable.tenantId, houseTenantId)");
  });
});

describe("receipts and deploy workflow", () => {
  it("centralizes receipt and printer sections", () => {
    const receipts = platform("pages/admin/receipts.tsx");
    for (const label of ["Receipts & Printers", "Reprint Receipts", "Templates", "Printers", "Routing", "Test Print"]) {
      expect(receipts).toContain(label);
    }
    expect(receipts).toContain("Printer hardware must be configured");
  });

  it("uses safer deploy flow and OAuth Tailscale tags", () => {
    const deploy = src(".github/workflows/deploy.yml");
    for (const required of ["VPS_KNOWN_HOSTS", "VPS_HOST_FALLBACK", "VPS_HOST_FALLBACK_PORT", "SELECTED_VPS_HOST", "SELECTED_VPS_PORT", "tags: tag:github-actions"]) {
      expect(deploy).toContain(required);
    }
    expect(deploy).toContain("docker compose build --pull");
    expect(deploy).toContain("docker compose up -d db");
    expect(deploy).toContain("docker compose run --rm migrate");
    expect(deploy).toContain("docker compose up -d api platform nginx");
    expect(deploy).not.toMatch(/docker compose down/);
  });
});
