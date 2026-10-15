import { describe, expect, it } from "vitest";
import { computeTenderTaxCents, customerTaxTreatment, dollarsToCents, isTaxableTender } from "../tenderTax";

describe("server-side tender tax allocation", () => {
  it("classifies stored-value Customer Credit as payment for taxable merchandise", () => {
    expect(customerTaxTreatment("customer_credit")).toBe("tax_added");
    expect(isTaxableTender("customer_credit")).toBe(true);
  });
  it.each(["cash", "paypal", "paypal_card"]) ("classifies %s as tax-added", tender => {
    expect(customerTaxTreatment(tender)).toBe("tax_added");
    expect(isTaxableTender(tender)).toBe(true);
  });
  it("keeps the full taxable base when stored value funds the entire purchase", () => {
    expect(computeTenderTaxCents({ taxableMerchandiseCents: 10000, taxRate: 0.0875 })).toEqual({ taxableBaseCents: 10000, taxCents: 875 });
  });
  it("taxes the full taxable merchandise when payment is split with stored value", () => {
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
