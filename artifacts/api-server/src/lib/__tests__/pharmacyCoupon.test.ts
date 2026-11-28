import { describe, expect, it, vi } from "vitest";
import type { NormalizedCartLine } from "../checkoutNormalizer";
import { couponAdjustedMerchandise, resolvePharmacyCoupon } from "../pharmacyCoupon";
import { allocateOrderLineRefundTax } from "../refundAccounting";

vi.mock("../singleTenant", () => ({ getHouseTenantId: async () => 1 }));

const line = (price: number, category = "Pharmacy", is_taxable = true, quantity = 1) =>
  ({ display_category: category, unit_price: price, quantity, is_taxable } as NormalizedCartLine);

describe("PHARMACY1", () => {
  it("requires five Pharmacy units and takes $1 off each", async () => {
    const belowMinimum = [line(7, "Pharmacy", true, 4), line(100, "Other")];
    await expect(resolvePharmacyCoupon(1, "PHARMACY1", belowMinimum)).rejects.toThrow("at least 5");
    await expect(resolvePharmacyCoupon(1, "PHARMACY1", belowMinimum, true)).resolves.toBeNull();
    const coupon = await resolvePharmacyCoupon(1, "PHARMACY1", [line(7, "Pharmacy", true, 5)]);
    expect(coupon).toMatchObject({ amountCents: 500, taxableCents: 500, lineDiscountCents: [500] });
    expect(couponAdjustedMerchandise({ subtotal: 35, taxableSubtotal: 35, nonTaxableSubtotal: 0 }, coupon).grossSubtotal).toBe(30);
  });

  it("caps discounts at each eligible unit's price", async () => {
    await expect(resolvePharmacyCoupon(1, "PHARMACY1", [line(0.25, "Pharmacy", true, 5), line(10, "Other")]))
      .resolves.toMatchObject({ amountCents: 125, lineDiscountCents: [125, 0] });
  });

  it("rejects unknown codes and other tenants", async () => {
    await expect(resolvePharmacyCoupon(1, "OTHER", [line(5)])).rejects.toThrow("unavailable");
    await expect(resolvePharmacyCoupon(2, "PHARMACY1", [line(5)])).rejects.toThrow("unavailable");
  });

  it("allocates only to Pharmacy lines and keeps partial refunds and tax consistent", async () => {
    const coupon = await resolvePharmacyCoupon(1, "PHARMACY1", [line(2.01, "Pharmacy", true, 2), line(2.99, "Pharmacy", false, 3), line(8.07, "Other")]);
    expect(coupon).toMatchObject({ lineDiscountCents: [200, 300, 0], taxableCents: 200 });
    expect(couponAdjustedMerchandise({ subtotal: 21.06, taxableSubtotal: 12.09, nonTaxableSubtotal: 8.97 }, coupon))
      .toEqual({ grossSubtotal: 16.06, taxableSubtotal: 10.09, nonTaxableSubtotal: 5.97 });
    const allocations = allocateOrderLineRefundTax({
      lines: [201, 299, 807].map((unitPriceCents, lineIndex) => ({
        lineIndex, unitPriceCents, orderItemId: lineIndex + 1, catalogItemId: lineIndex + 1,
        quantity: [2, 3, 1][lineIndex], taxable: lineIndex !== 1, couponDiscountCents: coupon?.lineDiscountCents[lineIndex],
      })),
      taxableDiscountCents: 0, nonTaxableDiscountCents: 0, taxCents: 77,
    });
    expect(allocations.map(item => item.discountCents)).toEqual([200, 300, 0]);
    expect(allocations.reduce((sum, item) => sum + item.taxCents, 0)).toBe(77);
  });
});
