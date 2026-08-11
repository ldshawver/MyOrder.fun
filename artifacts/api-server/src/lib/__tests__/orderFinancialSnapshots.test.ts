import { describe, expect, it } from "vitest";
import { computeOrderFinancialSnapshot } from "../orderFinancialSnapshots";

describe("immutable server-side order financial snapshots", () => {
  it("does not change taxability merely because tender is cash", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.08, taxMode: "added", tender: "cash", cashDiscount: { enabled: false, type: "percentage", value: 5 }, capturedAt: "2026-08-06T00:00:00.000Z" });
    expect(result).toMatchObject({ taxableSubtotal: 100, taxCollected: 8, merchandiseTotal: 108, cashDiscountAmount: 0 });
    expect(result.taxSnapshot.exemptionReason).toBeNull();
  });

  it("taxes the legitimate cash-discounted selling price", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.08, taxMode: "added", tender: "cash", cashDiscount: { enabled: true, type: "fixed", value: 5 } });
    expect(result).toMatchObject({ taxableSubtotal: 95, taxCollected: 7.6, merchandiseTotal: 102.6, cashDiscountAmount: 5 });
  });

  it("does not apply a cash discount to card tender", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.08, taxMode: "added", tender: "card", cashDiscount: { enabled: true, type: "percentage", value: 10 } });
    expect(result).toMatchObject({ taxableSubtotal: 100, taxCollected: 8, cashDiscountAmount: 0 });
  });
});
