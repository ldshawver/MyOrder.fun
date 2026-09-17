import { describe, expect, it } from "vitest";
import { getCatalogLifecycleStatus, lifecycleMetadataPatch } from "../catalog";

describe("catalog lifecycle metadata", () => {
  it("stores archive state at the canonical metadata root, preserves presentation/history, and is idempotent", () => {
    const original = { presentation: { displayName: "Synthetic product" }, importSource: "staging", auditMarker: "keep" };
    const archived = lifecycleMetadataPatch(original, { archived: true, complianceHold: false, lifecycleReason: "acceptance cleanup" });

    expect(archived).toMatchObject({
      archived: true,
      complianceHold: false,
      lifecycleReason: "acceptance cleanup",
      presentation: { displayName: "Synthetic product" },
      importSource: "staging",
      auditMarker: "keep",
    });
    expect(getCatalogLifecycleStatus({ isAvailable: false, alavontInStock: false, metadata: archived })).toBe("archived");
    expect(lifecycleMetadataPatch(archived, { archived: true, complianceHold: false, lifecycleReason: "acceptance cleanup" })).toEqual(archived);
  });

  it("keeps archived inventory-linked products non-customer-visible without mutating inventory history", () => {
    const metadata = lifecycleMetadataPatch({ presentation: { stockLabel: "historical" } }, { archived: true, lifecycleReason: "inventory-linked archive" });
    const inventoryHistory = Object.freeze({ balanceIds: [71], movementIds: [92], reservationIds: [14], valuation: "12.50" });

    expect(getCatalogLifecycleStatus({ isAvailable: false, alavontInStock: false, metadata })).toBe("archived");
    expect(inventoryHistory).toEqual({ balanceIds: [71], movementIds: [92], reservationIds: [14], valuation: "12.50" });
  });
});
