import { describe, expect, it } from "vitest";
import { computeTenderTaxCents, customerTaxTreatment, dollarsToCents, isTaxableDigitalTender } from "../tenderTax";

describe("server-side tender tax allocation", () => {
  it.each(["cash", "customer_credit"]) ("classifies %s as non-tax-added", tender => {
    expect(customerTaxTreatment(tender)).toBe("non_tax_added");
    expect(isTaxableDigitalTender(tender)).toBe(false);
  });
  it.each(["paypal", "paypal_card"]) ("classifies %s as taxable digital", tender => expect(isTaxableDigitalTender(tender)).toBe(true));
  it("charges no tax for fully cash or credit funded taxable merchandise", () => {
    expect(computeTenderTaxCents({ taxableMerchandiseCents: 10000, nonTaxableFundingCents: 10000, taxRate: 0.0875 })).toEqual({ taxableBaseCents: 0, taxCents: 0 });
  });
  it("taxes only the PayPal-funded portion after credit", () => {
    expect(computeTenderTaxCents({ taxableMerchandiseCents: 10000, nonTaxableFundingCents: 4000, taxRate: 0.0875 })).toEqual({ taxableBaseCents: 6000, taxCents: 525 });
  });
  it("rounds once in integer cents", () => {
    expect(computeTenderTaxCents({ taxableMerchandiseCents: 6, nonTaxableFundingCents: 0, taxRate: 0.0875 })).toEqual({ taxableBaseCents: 6, taxCents: 1 });
  });
  it("parses monetary values as cents without accepting fractional cents", () => {
    expect(dollarsToCents("100.00")).toBe(10000);
    expect(() => dollarsToCents("1.005")).toThrow();
  });
});
