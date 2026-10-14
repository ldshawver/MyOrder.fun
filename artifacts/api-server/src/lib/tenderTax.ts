export const CHECKOUT_TENDERS = ["cash", "paypal", "paypal_card", "customer_credit"] as const;
export type CheckoutTender = typeof CHECKOUT_TENDERS[number];

export type CustomerTaxTreatment = "non_tax_added" | "tax_added" | "unsupported";

export function customerTaxTreatment(tender: string): CustomerTaxTreatment {
  // Customer Credit is stored value used as payment. Payment source does not
  // change the taxability of the merchandise being purchased.
  if (tender === "gift_card") return "non_tax_added";
  if (tender === "cash" || tender === "paypal" || tender === "paypal_card" || tender === "customer_credit" || tender === "venmo" || tender === "cash_app" || tender === "apple_pay") return "tax_added";
  return "unsupported";
}

export function isTaxableTender(tender: string): boolean {
  return customerTaxTreatment(tender) === "tax_added";
}

/** Convert a canonical decimal dollar value to integer cents. */
export function dollarsToCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error("Invalid monetary value");
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) throw new Error("Monetary value exceeds safe cent range");
  return cents;
}

export function centsToDollars(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid cent amount");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function computeTenderTaxCents(input: {
  taxableMerchandiseCents: number;
  taxRate: number;
}): { taxableBaseCents: number; taxCents: number } {
  const taxableMerchandiseCents = input.taxableMerchandiseCents;
  if (!Number.isSafeInteger(taxableMerchandiseCents) || taxableMerchandiseCents < 0) throw new Error("Invalid taxable merchandise allocation");
  if (!Number.isFinite(input.taxRate) || input.taxRate < 0 || input.taxRate > 1) throw new Error("Invalid authoritative tax rate");
  const rateText = input.taxRate.toFixed(8);
  const [whole, fraction] = rateText.split(".");
  const rateUnits = BigInt(whole) * 100000000n + BigInt(fraction);
  // Stored-value payments reduce the amount due, never the taxable sale base.
  const taxableBaseCents = taxableMerchandiseCents;
  const taxCents = Number((BigInt(taxableBaseCents) * rateUnits + 50000000n) / 100000000n);
  if (!Number.isSafeInteger(taxCents)) throw new Error("Tax exceeds safe cent range");
  return { taxableBaseCents, taxCents };
}
