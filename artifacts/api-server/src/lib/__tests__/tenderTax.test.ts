import { describe, expect, it } from "vitest";
import { computeTenderTaxCents, customerTaxTreatment, dollarsToCents, isTransactionTaxedTender } from "../tenderTax";

describe("transaction tax independent of tender", () => {
  it.each(["cash", "customer_credit", "paypal", "paypal_card"]) ("uses the taxable sale for %s tender", tender => {
    expect(customerTaxTreatment(tender)).toBe("transaction_taxed");
    expect(isTransactionTaxedTender(tender)).toBe(true);
  });
  it("charges tax on all taxable merchandise even when store credit funds part of it", () => {
    expect(computeTenderTaxCents({ taxableMerchandiseCents: 10000, taxRate: 0.0875 })).toEqual({ taxableBaseCents: 10000, taxCents: 875 });
  });
  it("rounds once in integer cents", () => {
    expect(computeTenderTaxCents({ taxableMerchandiseCents: 6, taxRate: 0.0875 })).toEqual({ taxableBaseCents: 6, taxCents: 1 });
  });
  it("parses monetary values as cents without accepting fractional cents", () => {
    expect(dollarsToCents("100.00")).toBe(10000);
    expect(() => dollarsToCents("1.005")).toThrow();
  });
});
