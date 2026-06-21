import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../../../..");
const api = (path: string) => readFileSync(resolve(root, "artifacts/api-server/src", path), "utf8");
const platform = (path: string) => readFileSync(resolve(root, "artifacts/platform/src", path), "utf8");

const catalog = api("routes/catalog.ts");
const ai = api("routes/ai.ts");
const inventoryBalances = api("lib/inventoryBalances.ts");
const app = platform("App.tsx");
const layout = platform("components/layout.tsx");
const settings = platform("pages/admin/settings-page.tsx");
const editCatalog = platform("pages/admin/edit-catalog.tsx");

describe("catalog/admin cleanup protections", () => {
  it("removes the standalone Catalog Debug route/nav and moves diagnostics under Admin Settings", () => {
    expect(app).not.toContain("/admin/catalog-debug");
    expect(layout).not.toContain("Catalog Debug");
    expect(catalog).toContain('router.get("/admin/catalog/debug"');
    expect(catalog).toContain('res.status(404).json({ error: "Catalog Debug has moved to Admin Settings → Diagnostics" })');
    expect(catalog).toContain('"/admin/settings/diagnostics/catalog"');
    expect(settings).toContain('TabsTrigger value="diagnostics"');
    expect(settings).toContain('/api/admin/settings/diagnostics/catalog');
  });

  it("filters archived Safe-only duplicates from catalog, inventory/par, and Zappy", () => {
    for (const source of [catalog, ai, inventoryBalances]) {
      expect(source).toContain("safeOnlyDuplicate");
      expect(source).toContain("archived");
    }
    expect(catalog).toContain("activeProductRows(rows)");
    expect(inventoryBalances).toContain("eq(catalogItemsTable.isAvailable, true)");
    expect(ai).toContain("loadAvailableCatalog(tenantId)");
  });

  it("archives duplicate Safe-only rows into the Product Master parent and audits cleanup", () => {
    expect(catalog).toContain("archiveSafeDuplicateRows");
    expect(catalog).toContain("safeDuplicateMergedFrom");
    expect(catalog).toContain("mergedIntoCatalogItemId");
    expect(catalog).toContain('action: "catalog.safe_duplicates_merged"');
    expect(catalog).toContain('"/admin/product-master/cleanup-safe-duplicates"');
  });

  it("delete/archive endpoint is tenant scoped, audited, and returns JSON so the UI refreshes", () => {
    expect(catalog).toContain('router.delete("/catalog/:id"');
    expect(catalog).toContain("eq(catalogItemsTable.tenantId, houseTenantId)");
    expect(catalog).toContain('action: "catalog.archived"');
    expect(catalog).toContain('action: "catalog.deleted"');
    expect(catalog).toContain('res.json({ ok: true, mode: "archived"');
    expect(editCatalog).toContain("Archive / Delete");
    expect(editCatalog).toContain("await refetch()");
  });
});
