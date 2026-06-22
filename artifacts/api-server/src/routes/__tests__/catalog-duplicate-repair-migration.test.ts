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

  it("moves production references, archives duplicates, merges balances, and deletes catalog duplicates last", () => {
    expect(sql).toContain("catalog_item_duplicate_repair_archive");
    expect(sql).toContain("to_jsonb(dup)");
    expect(sql).toContain("UPDATE order_items oi");
    expect(sql).toContain("UPDATE inventory_templates it");
    expect(sql).toContain("UPDATE shift_inventory_items sii");
    expect(sql).toContain("JOIN catalog_item_duplicate_map m ON m.duplicate_id = ib.product_id");
    expect(sql).toContain("quantity_on_hand = COALESCE(keep.quantity_on_hand, 0) + COALESCE(moved.quantity_on_hand, 0)");
    expect(sql).toContain("par_level = GREATEST(COALESCE(keep.par_level, 0), COALESCE(moved.par_level, 0))");
    expect(sql.indexOf("INSERT INTO catalog_item_duplicate_repair_archive")).toBeLessThan(sql.indexOf("DELETE FROM catalog_items ci"));
  });
});
