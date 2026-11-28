import type { NormalizedCartLine } from "./checkoutNormalizer";
import { allocateCentsByWeight } from "./refundAccounting";
import { getHouseTenantId } from "./singleTenant";
import { centsToDollars, dollarsToCents } from "./tenderTax";

export const PHARMACY_COUPON_CODE = "PHARMACY1";

export async function hasPharmacyCoupon(tenantId: number): Promise<boolean> {
  return tenantId === await getHouseTenantId();
}

export class CheckoutCouponError extends Error {}

export async function resolvePharmacyCoupon(tenantId: number, code: string | undefined, lines: readonly NormalizedCartLine[], applyIfEligible = false) {
  if (!code) return null;
  if (code !== PHARMACY_COUPON_CODE || !await hasPharmacyCoupon(tenantId)) {
    throw new CheckoutCouponError("This coupon code is unavailable.");
  }

  const eligible = lines.map((line, index) => ({
    key: String(index),
    weight: line.display_category.trim().toLowerCase() === "pharmacy"
      ? dollarsToCents(line.unit_price) * line.quantity : 0,
    taxable: line.is_taxable !== false,
  }));
  if (eligible.reduce((sum, line) => sum + line.weight, 0) < 500) {
    if (applyIfEligible) return null;
    throw new CheckoutCouponError("Spend at least $5 on Pharmacy items before tax and delivery to use PHARMACY1.");
  }

  const allocated = allocateCentsByWeight(100, eligible);
  return {
    code,
    amountCents: 100,
    taxableCents: allocated.reduce((sum, line) => sum + (line.taxable ? line.amountCents : 0), 0),
    lineDiscountCents: allocated.map(line => line.amountCents),
  };
}

export function couponAdjustedMerchandise(totals: {
  subtotal: number; taxableSubtotal: number; nonTaxableSubtotal: number;
}, coupon: Awaited<ReturnType<typeof resolvePharmacyCoupon>>) {
  if (!coupon) return { grossSubtotal: totals.subtotal, taxableSubtotal: totals.taxableSubtotal, nonTaxableSubtotal: totals.nonTaxableSubtotal };
  const amount = (value: number, discount: number) => Number(centsToDollars(dollarsToCents(value) - discount));
  const { amountCents: discount, taxableCents: taxableDiscount } = coupon;
  return {
    grossSubtotal: amount(totals.subtotal, discount),
    taxableSubtotal: amount(totals.taxableSubtotal, taxableDiscount),
    nonTaxableSubtotal: amount(totals.nonTaxableSubtotal, discount - taxableDiscount),
  };
}
