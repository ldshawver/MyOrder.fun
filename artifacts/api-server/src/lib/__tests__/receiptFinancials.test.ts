import { describe, expect, it } from "vitest";
import { renderCustomerReceipt } from "../receiptRenderer";

describe("receipt financial facts", () => {
  it("shows tax, Customer Credit, remaining tender, safe capture reference, and cash facts", () => {
    const receipt = renderCustomerReceipt({ id: 9, items: [], subtotal: 20, discount: 0, taxableSubtotal: 20, taxRate: 0.0875, taxJurisdiction: "Sacramento", tax: 1.75, total: 21.75, customerCreditApplied: 10, remainingPaymentMethod: "PayPal card", remainingPaymentAmount: 11.75, providerCaptureReference: "CAPTURE-SENSITIVE-12345678", remainingCustomerCreditBalance: 4.25, cashTendered: 0, changeGiven: 0 });
    expect(receipt).toContain("Taxable subtotal"); expect(receipt).toContain("Sacramento"); expect(receipt).toContain("Customer Credit"); expect(receipt).toContain("PayPal card"); expect(receipt).toContain("…12345678");
    expect(receipt).not.toContain("CAPTURE-SENSITIVE");
  });
});
