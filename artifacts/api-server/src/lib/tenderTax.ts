export const CHECKOUT_TENDERS = ["cash", "paypal", "paypal_card", "customer_credit"] as const;
export type CheckoutTender = typeof CHECKOUT_TENDERS[number];

export type CustomerTaxTreatment = "non_tax_added" | "tax_added_digital" | "unsupported";

export function customerTaxTreatment(tender: string): CustomerTaxTreatment {
  if (tender === "cash" || tender === "customer_credit" || tender === "gift_card") return "non_tax_added";
  if (tender === "paypal" || tender === "paypal_card" || tender === "venmo" || tender === "cash_app" || tender === "apple_pay") return "tax_added_digital";
  return "unsupported";
}

export function isTaxableDigitalTender(tender: string): tender is "paypal" | "paypal_card" {
  return (tender === "paypal" || tender === "paypal_card") && customerTaxTreatment(tender) === "tax_added_digital";
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
  nonTaxableFundingCents: number;
  taxRate: number;
}): { taxableBaseCents: number; taxCents: number } {
  const taxableMerchandiseCents = input.taxableMerchandiseCents;
  const nonTaxableFundingCents = input.nonTaxableFundingCents;
  if (![taxableMerchandiseCents, nonTaxableFundingCents].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Invalid cent allocation");
  if (!Number.isFinite(input.taxRate) || input.taxRate < 0 || input.taxRate > 1) throw new Error("Invalid authoritative tax rate");
  const rateText = input.taxRate.toFixed(8);
  const [whole, fraction] = rateText.split(".");
  const rateUnits = BigInt(whole) * 100000000n + BigInt(fraction);
  const taxableBaseCents = Math.max(0, taxableMerchandiseCents - nonTaxableFundingCents);
  const taxCents = Number((BigInt(taxableBaseCents) * rateUnits + 50000000n) / 100000000n);
  if (!Number.isSafeInteger(taxCents)) throw new Error("Tax exceeds safe cent range");
  return { taxableBaseCents, taxCents };
}
