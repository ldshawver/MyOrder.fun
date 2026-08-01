import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const platformRoot = resolve(import.meta.dirname, "../../../../platform/src");
const layoutSource = readFileSync(resolve(platformRoot, "components/layout.tsx"), "utf8");
const inventoryPageSource = readFileSync(resolve(platformRoot, "pages/admin/inventory.tsx"), "utf8");
const inventoryRouteSource = readFileSync(resolve(import.meta.dirname, "../inventory.ts"), "utf8");
const shiftsRouteSource = readFileSync(resolve(import.meta.dirname, "../shifts.ts"), "utf8");

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe("inventory duplicate regression", () => {
  it("renders one navigation control for the canonical inventory route", () => {
    expect(count(layoutSource, /href:\s*"\/admin\/inventory"/g)).toBe(1);
    expect(layoutSource).toContain('label: "Inventory & Par"');
    expect(layoutSource).not.toContain('label: "Edit Inventory & Par"');
  });

  it("replaces inventory collections on refetch instead of appending", () => {
    expect(inventoryPageSource).toContain("setItems(itemsData)");
    expect(inventoryPageSource).toContain("setRows(fetched)");
    expect(inventoryPageSource).toContain("setBalances(data.balances ?? [])");
    expect(inventoryPageSource).not.toMatch(/setItems\(prev\s*=>\s*\[\.\.\.prev/);
    expect(inventoryPageSource).not.toMatch(/setBalances\(prev\s*=>\s*\[\.\.\.prev/);
  });

  it("keys legitimate inventory entities by stable database identifiers", () => {
    expect(inventoryPageSource).toContain("<div key={productId}");
    expect(inventoryPageSource).toContain("<div key={loc.id}");
    expect(inventoryPageSource).toContain("init[`${item.id}:${loc.locationId}`]");
  });

  it("keeps inventory API reads tenant-scoped without cosmetic response deduplication", () => {
    expect(inventoryRouteSource).toContain("resolveInventoryTenantId(req)");
    expect(shiftsRouteSource).toContain("eq(inventoryBalancesTable.tenantId, houseTenantId)");
    expect(shiftsRouteSource).toContain("eq(inventoryLocationsTable.tenantId, houseTenantId)");
    expect(inventoryRouteSource).not.toMatch(/new Set\([^)]*snapshot\.items/);
  });
});
