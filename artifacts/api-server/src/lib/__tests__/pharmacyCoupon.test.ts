import { describe, expect, it, vi } from "vitest";
import type { NormalizedCartLine } from "../checkoutNormalizer";
import { couponAdjustedMerchandise, resolvePharmacyCoupon } from "../pharmacyCoupon";
import { allocateOrderLineRefundTax } from "../refundAccounting";

vi.mock("../singleTenant", () => ({ getHouseTenantId: async () => 1 }));

const line = (price: number, category = "Pharmacy", is_taxable = true) =>
  ({ display_category: category, unit_price: price, quantity: 1, is_taxable } as NormalizedCartLine);

describe("PHARMACY1", () => {
  it("requires $5 of Pharmacy merchandise regardless of the rest of the cart", async () => {
    await expect(resolvePharmacyCoupon(1, "PHARMACY1", [line(4.99), line(100, "Other")])).rejects.toThrow("at least $5");
    await expect(resolvePharmacyCoupon(1, "PHARMACY1", [line(5)])).resolves.toMatchObject({ amountCents: 100 });
  });

  it("rejects unknown codes and other tenants", async () => {
    await expect(resolvePharmacyCoupon(1, "OTHER", [line(5)])).rejects.toThrow("unavailable");
    await expect(resolvePharmacyCoupon(2, "PHARMACY1", [line(5)])).rejects.toThrow("unavailable");
  });

  it("allocates only to Pharmacy lines and keeps partial refunds and tax consistent", async () => {
    const coupon = await resolvePharmacyCoupon(1, "PHARMACY1", [line(2.01), line(2.99, "Pharmacy", false), line(8.07, "Other")]);
    expect(coupon).toMatchObject({ lineDiscountCents: [40, 60, 0], taxableCents: 40 });
    expect(couponAdjustedMerchandise({ subtotal: 13.07, taxableSubtotal: 10.08, nonTaxableSubtotal: 2.99 }, coupon))
      .toEqual({ grossSubtotal: 12.07, taxableSubtotal: 9.68, nonTaxableSubtotal: 2.39 });
    const allocations = allocateOrderLineRefundTax({
      lines: [201, 299, 807].map((unitPriceCents, lineIndex) => ({
        lineIndex, unitPriceCents, orderItemId: lineIndex + 1, catalogItemId: lineIndex + 1,
        quantity: 1, taxable: lineIndex !== 1, couponDiscountCents: coupon?.lineDiscountCents[lineIndex],
      })),
      taxableDiscountCents: 0, nonTaxableDiscountCents: 0, taxCents: 77,
    });
    expect(allocations.map(item => item.discountCents)).toEqual([40, 60, 0]);
    expect(allocations.reduce((sum, item) => sum + item.taxCents, 0)).toBe(77);
  });
});
