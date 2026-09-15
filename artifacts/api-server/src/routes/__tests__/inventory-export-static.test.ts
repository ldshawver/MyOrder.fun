import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const source = readFileSync(resolve(root, "artifacts/api-server/src/routes/inventory.ts"), "utf8");

describe("inventory snapshot export", () => {
  it("includes canonical replenishment columns and only adds WAC after server authorization", () => {
    expect(source).toContain('"MOQ", "Preferred Reorder Quantity"');
    expect(source).toContain("mayViewCost");
    expect(source).toContain("catalogWac");
    expect(source).toContain("nonCatalogWac");
  });
  it("exports a snapshot, not immutable movement history", () => {
    const exportSource = source.slice(source.indexOf('router.get("/admin/inventory/export"'), source.indexOf('// ─── GET /api/admin/inventory/orphans'));
    expect(exportSource).not.toContain("inventoryMovementsTable");
    expect(exportSource).not.toContain("movementHistory");
  });
});
