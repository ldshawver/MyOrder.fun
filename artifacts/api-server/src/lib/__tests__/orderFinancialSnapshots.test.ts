import { describe, expect, it } from "vitest";
import { computeOrderFinancialSnapshot } from "../orderFinancialSnapshots";

describe("authoritative tender financial snapshots", () => {
  const discount = { enabled: false, type: "percentage" as const, value: 0 };

  it("adds tax to a taxable cash sale", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.0875, taxMode: "added", tender: "cash", cashDiscount: discount });
    expect(result).toMatchObject({ taxableSubtotal: 100, taxCollected: 8.75, merchandiseTotal: 108.75 });
  });

  it("keeps Customer Credit tender from changing the taxable sale", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.0875, taxMode: "added", tender: "customer_credit", cashDiscount: discount });
    expect(result).toMatchObject({ taxCollected: 8.75, merchandiseTotal: 108.75 });
  });

  it("does not reduce transaction tax when Customer Credit funds part of a PayPal order", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxableSubtotal: 100, taxRate: 0.0875, taxMode: "added", tender: "paypal", cashDiscount: discount });
    expect(result).toMatchObject({ taxableSubtotal: 100, taxCollected: 8.75, merchandiseTotal: 108.75 });
    expect(result.taxSnapshot).toMatchObject({ customerTaxableTenderBase: 100, customerTaxCollected: 8.75 });
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

  it("calculates cash tax once on the discounted taxable subtotal", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.08, taxMode: "added", tender: "cash", cashDiscount: { enabled: true, type: "fixed", value: 5 } });
    expect(result).toMatchObject({ taxableSubtotal: 95, taxCollected: 7.6, merchandiseTotal: 102.6, cashDiscountAmount: 5 });
  });

  it("includes cash sales tax in the displayed amount while retaining tax accounting", () => {
    const result = computeOrderFinancialSnapshot({ grossSubtotal: 100, taxableSubtotal: 100, taxRate: 0.08, taxMode: "included", tender: "cash", cashDiscount: discount });
    expect(result).toMatchObject({ taxableSubtotal: 92.59, taxCollected: 7.41, merchandiseTotal: 100 });
    expect(result.taxSnapshot).toMatchObject({ taxMode: "included", customerTaxableTenderBase: 92.59, customerTaxCollected: 7.41, tender: "cash" });
  });

  it("rejects tax-inclusive price display for non-cash tender", () => {
    expect(() => computeOrderFinancialSnapshot({ grossSubtotal: 100, taxRate: 0.08, taxMode: "included", tender: "paypal", cashDiscount: discount })).toThrow("only valid for cash tender");
  });
});
