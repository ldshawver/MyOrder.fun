import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const route = readFileSync(resolve(root, "artifacts/api-server/src/routes/inventoryFloor.ts"), "utf8");
const store = readFileSync(resolve(root, "artifacts/api-server/src/lib/inventoryFloor.ts"), "utf8");
const page = readFileSync(resolve(root, "artifacts/platform/src/pages/admin/inventory.tsx"), "utf8");
const floorPage = readFileSync(resolve(root, "artifacts/platform/src/pages/admin/inventoryFloor.tsx"), "utf8");
const roles = readFileSync(resolve(root, "artifacts/api-server/src/lib/roles.ts"), "utf8");

describe("inventory floor access", () => {
  it("lets a CSR, supervisor, or admin run both phone flows", () => {
    expect(route).toContain('requireRole("csr", "supervisor", "admin")');
    expect(route).toContain('"/admin/inventory-floor/counts"');
    expect(route).toContain('"/admin/inventory-floor/receipts"');
    expect(page).toContain("InventoryFloorLaunch");
    expect(floorPage).toContain("Take inventory");
    expect(floorPage).toContain("Receive order");
    expect(floorPage).toContain("One spot, or the whole shop?");
    expect(floorPage).toContain("Where do you want to start?");
    expect(floorPage).toContain("Suggest an item to add");
    expect(floorPage).toContain("Suggest a change");
  });

  it("posts counts and receipts through the ledger and does not give CSRs full inventory management", () => {
    expect(store).toContain("postInventoryMovement");
    expect(store).toContain("postInventoryReceipt");
    expect(store).toContain("postCatalogOpeningCount");
    expect(store).toContain("special_catalog_item_id");
    expect(store).toContain("FLOOR_LOCAL_CATALOG_SQL");
    expect(route).not.toContain("inventory.manage");
    const csrExtra = roles.slice(roles.indexOf("const csrExtra"), roles.indexOf("const supervisorExtra"));
    expect(csrExtra).not.toContain("inventory.manage");
    expect(roles).toContain('"inventory.manage"');
  });
});
