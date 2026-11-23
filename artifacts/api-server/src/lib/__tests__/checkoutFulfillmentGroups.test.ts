import { describe, expect, it } from "vitest";
import { checkoutGroupsAllowCash, luciferDirectCarrierLines, planCheckoutFulfillmentGroups, snapshotCheckoutFulfillmentGroups } from "../checkoutFulfillmentGroups";
import type { NormalizedCartLine } from "../checkoutNormalizer";

function line(overrides: Partial<NormalizedCartLine>): NormalizedCartLine {
  return {
    original_catalog_item_id: 1, catalog_item_id: 1, source_type: "local_mapped", merchant_brand: "alavont",
    catalog_display_name: "Item", merchant_name: "Item", merchant_sku: "SKU", display_name: "Item",
    display_description: "Description", display_category: "Category", display_image: null,
    merchant_brand_name: "Lucifer Cruz", marketing_copy: "Description", customer_safe_name: "Item",
    customer_safe_description: "Description", customer_safe_category: "Category", customer_safe_image: null,
    upsell_copy: null, promo_badges: [], receipt_alavont_name: "Item", receipt_lucifer_name: "Item",
    merchant_image_url: null, unit_price: 10, quantity: 1, line_subtotal: 10, is_taxable: true,
    alavont_id: null, woo_product_id: null, woo_variation_id: null, lab_name: null, receipt_name: null,
    label_name: null, ...overrides,
  };
}

describe("server-created checkout fulfillment groups", () => {
  it("partitions a mixed cart from trusted source and brand fields", () => {
    const groups = planCheckoutFulfillmentGroups([
      line({ catalog_item_id: 10 }),
      line({ catalog_item_id: 20, merchant_brand: "lucifer_cruz" }),
      line({ catalog_item_id: 30, source_type: "woo", merchant_brand: "lucifer_cruz", woo_product_id: "cj-30" }),
    ], "pickup");
    expect(groups).toEqual([
      { key: "alavont:pickup", provider: "alavont", method: "pickup", lineIndexes: [0] },
      { key: "lucifer_direct:pickup", provider: "lucifer_direct", method: "pickup", lineIndexes: [1] },
      { key: "cj:standard_shipping", provider: "cj", method: "standard_shipping", lineIndexes: [2] },
    ]);
    expect(checkoutGroupsAllowCash(groups)).toBe(false);
  });

  it("preserves Alavont pickup cash eligibility and rejects courier cash", () => {
    expect(checkoutGroupsAllowCash(planCheckoutFulfillmentGroups([line({})], "pickup"))).toBe(true);
    expect(checkoutGroupsAllowCash(planCheckoutFulfillmentGroups([line({})], "uber_direct"))).toBe(false);
  });

  it("selects carrier-rated lines only from the trusted Lucifer Direct group", () => {
    const lucifer = line({ catalog_item_id: 20, merchant_brand: "lucifer_cruz" });
    const lines = [line({ catalog_item_id: 10 }), lucifer, line({ catalog_item_id: 30, source_type: "woo" })];
    expect(luciferDirectCarrierLines(lines)).toEqual([lucifer]);
    expect(() => luciferDirectCarrierLines([lines[0]!])).toThrow("CARRIER_GROUP_UNAVAILABLE");
  });

  it("snapshots a distinct trusted destination for every server-created group", () => {
    const groups = planCheckoutFulfillmentGroups([
      line({}),
      line({ source_type: "woo", woo_product_id: "cj-2" }),
    ], "pickup");
    expect(snapshotCheckoutFulfillmentGroups(groups, {
      pickup: { locationId: 7, pickupAt: "2026-11-23T12:00:00.000Z" },
      shippingAddress: "  123 Main St  ",
    })).toEqual([
      { key: "alavont:pickup", provider: "alavont", method: "pickup", destination: { type: "pickup", locationId: 7, pickupAt: "2026-11-23T12:00:00.000Z" } },
      { key: "cj:standard_shipping", provider: "cj", method: "standard_shipping", destination: { type: "customer_address", address: "123 Main St" } },
    ]);
  });
});
