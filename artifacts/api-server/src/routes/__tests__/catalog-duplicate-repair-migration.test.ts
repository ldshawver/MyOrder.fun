import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "../../lib/db/drizzle/0026_repair_duplicate_catalog_items.sql"), "utf8");

describe("duplicate catalog repair migration", () => {
  it("detects production-style duplicates by lower(trim(name))", () => {
    expect(sql).toContain("lower(trim(ci.name)) AS normalized_name");
    expect(sql).toContain("PARTITION BY tenant_id, normalized_name");
    expect(sql).toContain("HAVING count(*) > 1");
  });

  it("chooses canonical rows by POS references before lowest id", () => {
    expect(sql).toContain("EXISTS (SELECT 1 FROM order_items oi WHERE oi.catalog_item_id = ci.id) AS has_order_items");
    expect(sql).toContain("EXISTS (SELECT 1 FROM shift_inventory_items sii WHERE sii.catalog_item_id = ci.id) AS has_shift_inventory_items");
    expect(sql).toContain("EXISTS (SELECT 1 FROM inventory_balances ib WHERE ib.product_id = ci.id) AS has_inventory_balances");
    expect(sql).toContain("has_order_items DESC");
    expect(sql).toContain("has_shift_inventory_items DESC");
    expect(sql).toContain("has_inventory_balances DESC");
    expect(sql).toContain("id ASC");
  });

  it("moves production references, archives duplicates, and leaves inventory balances to authority tooling", () => {
    expect(sql).toContain("catalog_item_duplicate_repair_archive");
    expect(sql).toContain("to_jsonb(dup)");
    expect(sql).toContain("UPDATE order_items oi");
    expect(sql).toContain("UPDATE inventory_templates it");
    expect(sql).toContain("UPDATE shift_inventory_items sii");
    expect(sql).toContain("Inventory balances are intentionally not mutated here.");
    expect(sql).toContain("inventoryAuthority");
    expect(sql).not.toContain("UPDATE inventory_balances");
    expect(sql).not.toContain("DELETE FROM inventory_balances");
    expect(sql.indexOf("INSERT INTO catalog_item_duplicate_repair_archive")).toBeLessThan(sql.indexOf("DELETE FROM catalog_items ci"));
  });
});
