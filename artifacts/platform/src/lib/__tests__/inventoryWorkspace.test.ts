import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../pages/admin/inventory.tsx", import.meta.url), "utf8");

describe("consolidated inventory workspace", () => {
  it("opens on the single canonical inventory workspace", () => {
    expect(source).toContain('useState<"combined" | "locations">("combined")');
    expect(source).toContain('{ key: "combined" as const, label: "Inventory"');
    expect(source).not.toContain('{ key: "stockgrid" as const, label: "All Inventory"');
  });

  it("provides searchable, server-authoritative catalogue and non-catalogue inventory", () => {
    expect(source).toContain('Search inventory');
    expect(source).toContain('Non-Catalogue Inventory');
    expect(source).toContain('server projections');
    expect(source).not.toContain('const saveBalance = async (balance: InventoryBalance)');
    expect(source).not.toContain('`/api/admin/inventory-balances/${balance.id}`');
  });

  it("keeps movements behind the canonical detail workflow and refreshes balances after success", () => {
    expect(source).toContain('openAction={detail.action}');
    expect(source).toContain('<Button size="sm" onClick={actions.receive}>Receive</Button>');
    expect(source).toContain('<Button size="sm" variant="outline" onClick={actions.transfer}>Transfer</Button>');
    expect(source).toContain('onClick={actions.loss}>Loss');
    expect(source).toContain('movementType: "waste"');
    expect(source).toContain('onChanged?.();');
  });
});
