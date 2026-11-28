import type { NormalizedCartLine } from "./checkoutNormalizer";
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

  const eligible = lines.map(line => {
    const quantity = line.display_category.trim().toLowerCase() === "pharmacy" ? line.quantity : 0;
    return {
      quantity,
      amountCents: Math.min(100, dollarsToCents(line.unit_price)) * quantity,
      taxable: line.is_taxable !== false,
    };
  });
  if (eligible.reduce((sum, line) => sum + line.quantity, 0) < 5) {
    if (applyIfEligible) return null;
    throw new CheckoutCouponError("Add at least 5 Pharmacy items to use PHARMACY1.");
  }

  return {
    code,
    amountCents: eligible.reduce((sum, line) => sum + line.amountCents, 0),
    taxableCents: eligible.reduce((sum, line) => sum + (line.taxable ? line.amountCents : 0), 0),
    lineDiscountCents: eligible.map(line => line.amountCents),
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
