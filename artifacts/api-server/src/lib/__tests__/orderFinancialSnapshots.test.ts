import { describe, expect, it } from "vitest";
import { computeOrderFinancialSnapshot } from "../orderFinancialSnapshots";

describe("authoritative tender financial snapshots", () => {
  const discount = { enabled: false, type: "percentage" as const, value: 0 };

  it("does not add customer tax to a cash order", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.0875, taxMode: "added", tender: "cash", cashDiscount: discount });
    expect(result).toMatchObject({ taxableSubtotal: 100, taxCollected: 0, merchandiseTotal: 100 });
  });

  it("does not add customer tax to Customer Credit", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.0875, taxMode: "added", tender: "customer_credit", cashDiscount: discount });
    expect(result).toMatchObject({ taxCollected: 0, merchandiseTotal: 100 });
  });

  it("taxes only the PayPal-funded taxable cents", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxableSubtotal: 100, taxRate: 0.0875, taxMode: "added", tender: "paypal", nonTaxableFundingCents: 4000, cashDiscount: discount });
    expect(result).toMatchObject({ taxableSubtotal: 100, taxCollected: 5.25, merchandiseTotal: 105.25 });
    expect(result.taxSnapshot).toMatchObject({ customerTaxableTenderBase: 60, customerTaxCollected: 5.25 });
  });

  it("keeps non-taxable merchandise untaxed under PayPal", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 20, taxableSubtotal: 12, nonTaxableSubtotal: 8, taxRate: 0.0875, taxMode: "added", tender: "paypal", cashDiscount: discount });
    expect(result).toMatchObject({ taxCollected: 1.05, merchandiseTotal: 21.05 });
  });

  it.each(["cash", "customer_credit", "paypal", "paypal_card"])("never taxes non-taxable-only merchandise with %s", tender => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 12.34, taxableSubtotal: 0, nonTaxableSubtotal: 12.34, taxRate: 0.0875, taxMode: "added", tender, cashDiscount: discount });
    expect(result).toMatchObject({ taxCollected: 0, merchandiseTotal: 12.34 });
  });

  it("rounds tax once in integer cents", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 0.06, taxRate: 0.0875, taxMode: "added", tender: "paypal", cashDiscount: discount });
    expect(result.taxCollected).toBe(0.01);
  });

  it("preserves cash discount while keeping cash untaxed", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.08, taxMode: "added", tender: "cash", cashDiscount: { enabled: true, type: "fixed", value: 5 } });
    expect(result).toMatchObject({ taxableSubtotal: 95, taxCollected: 0, merchandiseTotal: 95, cashDiscountAmount: 5 });
  });

  it("rejects an unsupported included-tax mode instead of silently misallocating tender tax", () => {
    expect(() => computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.08, taxMode: "included", tender: "paypal", cashDiscount: discount })).toThrow("Unsupported tender tax mode");
  });
});
