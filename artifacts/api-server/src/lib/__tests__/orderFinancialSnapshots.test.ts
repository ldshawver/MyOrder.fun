import { describe, expect, it } from "vitest";
import { computeOrderFinancialSnapshot } from "../orderFinancialSnapshots";

describe("authoritative tender financial snapshots", () => {
  const discount = { enabled: false, type: "percentage" as const, value: 0 };

  it("adds configured customer tax to taxable cash merchandise", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.0875, taxMode: "added", tender: "cash", cashDiscount: discount });
    expect(result).toMatchObject({ taxableSubtotal: 100, taxCollected: 8.75, merchandiseTotal: 108.75 });
    expect(result.taxSnapshot).toMatchObject({ customerTaxableTenderBase: 100, exemptionReason: null, tender: "cash" });
  });

  it("adds merchandise tax when Customer Credit funds the purchase", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.0875, taxMode: "added", tender: "customer_credit", cashDiscount: discount });
    expect(result).toMatchObject({ taxableSubtotal: 100, taxCollected: 8.75, merchandiseTotal: 108.75 });
  });

  it("does not reduce the PayPal taxable base when stored value is applied", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxableSubtotal: 100, taxRate: 0.0875, taxMode: "added", tender: "paypal", cashDiscount: discount });
    expect(result).toMatchObject({ taxableSubtotal: 100, taxCollected: 8.75, merchandiseTotal: 108.75 });
    expect(result.taxSnapshot).toMatchObject({ customerTaxableTenderBase: 100, customerTaxCollected: 8.75 });
  });

  it("taxes only taxable items for both cash and PayPal", () => {
    for (const tender of ["cash", "paypal"]) {
      const result = computeOrderFinancialSnapshot({ grossSubtotal: 30, taxableSubtotal: 20, nonTaxableSubtotal: 10, taxRate: 0.0875, taxMode: "added", tender, cashDiscount: discount });
      expect(result).toMatchObject({ taxableSubtotal: 20, nonTaxableSubtotal: 10, taxCollected: 1.75, merchandiseTotal: 31.75 });
    }
  });

  it("keeps mixed merchandise taxability independent of Customer Credit funding", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 120, taxableSubtotal: 100, nonTaxableSubtotal: 20, taxRate: 0.0875, taxMode: "added", tender: "customer_credit", cashDiscount: discount });
    expect(result).toMatchObject({ taxableSubtotal: 100, nonTaxableSubtotal: 20, taxCollected: 8.75, merchandiseTotal: 128.75 });
    expect(result.taxSnapshot).toMatchObject({ taxableMerchandiseBase: 100, customerTaxCollected: 8.75 });
  });

  it("keeps non-taxable merchandise untaxed under PayPal", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 20, taxableSubtotal: 12, nonTaxableSubtotal: 8, taxRate: 0.0875, taxMode: "added", tender: "paypal", cashDiscount: discount });
    expect(result).toMatchObject({ taxCollected: 1.05, merchandiseTotal: 21.05 });
  });

  it.each(["cash", "customer_credit", "paypal", "paypal_card"])("never taxes non-taxable-only merchandise with %s", tender => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 12.34, taxableSubtotal: 0, nonTaxableSubtotal: 12.34, taxRate: 0.0875, taxMode: "added", tender, cashDiscount: discount });
    expect(result).toMatchObject({ taxCollected: 0, merchandiseTotal: 12.34 });
  });

  it.each(["cash", "paypal"]) ("rounds %s tax once in integer cents", tender => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 0.06, taxRate: 0.0875, taxMode: "added", tender, cashDiscount: discount });
    expect(result.taxCollected).toBe(0.01);
  });

  it("applies fixed cash discount before calculating tax", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.08, taxMode: "added", tender: "cash", cashDiscount: { enabled: true, type: "fixed", value: 5 } });
    expect(result).toMatchObject({ taxableSubtotal: 95, taxCollected: 7.6, merchandiseTotal: 102.6, cashDiscountAmount: 5 });
  });

  it("apportions cash discounts across taxable and nontaxable lines before tax", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 30, taxableSubtotal: 20, nonTaxableSubtotal: 10, taxRate: 0.1, taxMode: "added", tender: "cash", cashDiscount: { enabled: true, type: "fixed", value: 3 } });
    expect(result).toMatchObject({ taxableSubtotal: 18, nonTaxableSubtotal: 9, taxCollected: 1.8, merchandiseTotal: 28.8, cashDiscountAmount: 3 });
  });

  it("rejects an unsupported included-tax mode instead of silently misallocating tender tax", () => {
    expect(() => computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.08, taxMode: "included", tender: "paypal", cashDiscount: discount })).toThrow("Unsupported tender tax mode");
  });
});
