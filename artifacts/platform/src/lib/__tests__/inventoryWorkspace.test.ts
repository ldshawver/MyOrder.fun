import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../pages/admin/inventory.tsx", import.meta.url), "utf8");

describe("consolidated inventory workspace", () => {
  it("opens on operational inventory rather than a configuration template", () => {
    expect(source).toContain('useState<"template" | "locations" | "stockgrid" | "health" | "noncatalog">("stockgrid")');
    expect(source).toContain('{ key: "stockgrid" as const, label: "All Inventory"');
    expect(source).not.toContain('{ key: "stock" as const, label: "Stock Levels"');
  });

  it("provides a searchable, read-only authoritative balance grid", () => {
    expect(source).toContain('aria-label="Search catalogue inventory"');
    expect(source).toContain('SKU {sku}');
    expect(source).toContain('PAR {b.parLevel}');
    expect(source).not.toContain('const saveBalance = async (balance: InventoryBalance)');
    expect(source).not.toContain('`/api/admin/inventory-balances/${balance.id}`');
  });

  it("keeps movements behind the canonical detail workflow and refreshes balances after success", () => {
    expect(source).toContain('onChanged={() => { void fetchBalances(); }}');
    expect(source).toContain('<Button size="sm" onClick={() => setAction("receipt")}>Receive</Button>');
    expect(source).toContain('<Button size="sm" variant="outline" onClick={() => setAction("transfer")}>Transfer</Button>');
    expect(source).toContain('Record Loss');
    expect(source).toContain('movementType: "waste"');
    expect(source).toContain('onChanged?.();');
  });
});
