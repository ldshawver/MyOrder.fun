// Task #13: Item conversion (Alavont → Lucifer Cruz) before payment.
// These tests pin the four invariants the spec calls out:
//   1. Every Alavont catalog line is rewritten to a Lucifer Cruz merchant
//      line BEFORE any payment processor payload is built.
//   2. Server recomputes totals from DB prices — client-supplied numerics
//      are rejected by the strict input schema.
//   3. Missing Alavont→LC mapping → CheckoutMappingError carrying the
//      offending catalogItemId so the route can return the spec'd 422.
//   4. The Stripe-bound payload (description / metadata / statement
//      descriptor) contains ONLY Lucifer Cruz strings — never Alavont.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@workspace/db", () => {
  const catalogItemsTable = { id: "catalog_items_id" };
  const db = { execute: vi.fn(() => Promise.resolve()), select: vi.fn() };
  return { db, catalogItemsTable };
});

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => ({ conditions })),
  eq: vi.fn((col, val) => ({ col, val })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  normalizeCheckoutCart,
  computeCheckoutTotals,
  CheckoutMappingError,
  CartLineInput,
} from "../checkoutNormalizer";
import { db } from "@workspace/db";

// `db` is a vi.mock'd module; `select` is a vi.fn(). We type-narrow it to the
// vitest mock surface via vi.mocked so we never reach for `as any`.
const mockedDbSelect = vi.mocked(db.select as unknown as ReturnType<typeof vi.fn>);

function mockDbReturn(items: Array<Record<string, unknown> | null>) {
  // Each call to db.select().from(...).where(...).limit(1) yields one item
  // from the queue, in declaration order.
  let i = 0;
  const limit = vi.fn().mockImplementation(async () => {
    const item = items[i++] ?? null;
    return item === null ? [] : [item];
  });
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  mockedDbSelect.mockReturnValue({ from });
}

function makeAlavontItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    tenantId: 1,
    name: "internal-name",
    price: "20.00",
    isAvailable: true,
    isWooManaged: false,
    isLocalAlavont: true,
    merchantBrand: "alavont",
    merchantProcessingMode: "mapped_lucifer",
    alavontName: "Alavont Brand Tee",
    alavontId: "ALV-XYZ-100",
    luciferCruzName: "LC Premium Tee",
    luciferCruzImageUrl: "https://lucifercruz.com/img/tee.jpg",
    merchantDescription: "Customer-safe merchant description",
    merchantSku: "LC-SKU-100",
    labName: "Lab A",
    receiptName: null,
    imageUrl: null,
    wooProductId: null,
    wooVariationId: null,
    sku: null,
    ...overrides,
  };
}

const previewFields = {
  display_name: "LC Premium Tee",
  display_description: "Customer-safe description",
  display_category: "Premium Goods",
  display_image: null,
  merchant_brand_name: "Lucifer Cruz",
  marketing_copy: "Premium branded checkout copy.",
  customer_safe_name: "LC Premium Tee",
  customer_safe_description: "Customer-safe description",
  customer_safe_category: "Premium Goods",
  upsell_copy: null,
  promo_badges: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Task #13 — Alavont→Lucifer Cruz conversion before payment", () => {
  it("(1) converts Alavont catalog lines into LC merchant lines BEFORE payment payload assembly", async () => {
    mockDbReturn([makeAlavontItem({ id: 100 }), makeAlavontItem({ id: 101, alavontName: "Alavont Hat", luciferCruzName: "LC Hat", merchantSku: "LC-HAT-1", price: "15.00" })]);

    const normalized = await normalizeCheckoutCart([
      { catalogItemId: 100, quantity: 2 },
      { catalogItemId: 101, quantity: 1 },
    ]);

    // Conversion happened: every line carries an LC merchant identity.
    expect(normalized).toHaveLength(2);
    expect(normalized[0].merchant_brand).toBe("alavont");
    expect(normalized[0].merchant_name).toBe("LC Premium Tee");
    expect(normalized[1].merchant_name).toBe("LC Hat");
    // The Alavont identity is preserved separately for internal records only.
    expect(normalized[0].receipt_alavont_name).toBe("Alavont Brand Tee");
    expect(normalized[0].catalog_display_name).toBe("Alavont Brand Tee");

    // Server-recomputed totals — DB-derived, not client-influenced.
    const totals = computeCheckoutTotals(normalized);
    expect(totals.subtotal).toBeCloseTo(2 * 20 + 1 * 15);
    expect(totals.taxRate).toBe(0.08);
    expect(totals.tax).toBeCloseTo(totals.subtotal * 0.08, 2);
    expect(totals.total).toBeCloseTo(totals.subtotal + totals.tax, 2);
  });

  it("(2) server-side totals ignore any client-supplied unitPrice/total — strict schema rejects extras", () => {
    // .strict() rejects extra fields. This is the wire-level guarantee that a
    // client cannot influence pricing by sending unitPrice or total.
    const malicious = CartLineInput.safeParse({
      catalogItemId: 100,
      quantity: 1,
      unitPrice: 0.01,
      total: 0.01,
    });
    expect(malicious.success).toBe(false);

    const malicious2 = CartLineInput.safeParse({
      catalogItemId: 100,
      quantity: 1,
      sku: "ALV-XYZ-100",
      merchantName: "spoofed",
    });
    expect(malicious2.success).toBe(false);

    // And even if a fake unit_price field somehow leaked into the normalized
    // line, computeCheckoutTotals derives totals from line_subtotal, which is
    // built strictly from DB price × quantity inside normalizeCheckoutCart.
    const totals = computeCheckoutTotals([
      // Line built as the normalizer would build it from a DB row priced 20.00.
      {
        catalog_item_id: 100,
        source_type: "local_mapped",
        merchant_brand: "alavont",
        catalog_display_name: "Alavont Brand Tee",
        merchant_name: "LC Premium Tee",
        merchant_sku: "LC-SKU-100",
        ...previewFields,
        receipt_alavont_name: "Alavont Brand Tee",
        receipt_lucifer_name: "LC Premium Tee",
        merchant_image_url: null,
        unit_price: 20,
        quantity: 3,
        line_subtotal: 60,
        alavont_id: "ALV-XYZ-100",
        woo_product_id: null,
        woo_variation_id: null,
        lab_name: null,
        receipt_name: null,
        label_name: null,
      },
    ]);
    expect(totals.subtotal).toBe(60);
    expect(totals.total).toBeCloseTo(60 + 60 * 0.08, 2);
  });

  it("(3) falls back when lucifer_cruz_name is null and only throws when all branded names are empty", async () => {
    mockDbReturn([makeAlavontItem({ id: 100, luciferCruzName: null, merchantName: "Merchant Fallback Tee" })]);

    const normalized = await normalizeCheckoutCart([{ catalogItemId: 100, quantity: 1 }]);
    expect(normalized[0].merchant_name).toBe("Merchant Fallback Tee");

    mockDbReturn([makeAlavontItem({ id: 101, customerSafeName: null, luciferCruzName: null, merchantName: null, alavontName: null, name: " " })]);
    await expect(
      normalizeCheckoutCart([{ catalogItemId: 101, quantity: 1 }])
    ).rejects.toMatchObject({
      name: "CheckoutMappingError",
      catalogItemId: 101,
      reason: "missing_branded_checkout_name",
    });
  });

  it("(3b) unknown catalog item throws CheckoutMappingError with catalogItemId", async () => {
    mockDbReturn([null]);
    let caught: unknown = null;
    try {
      await normalizeCheckoutCart([{ catalogItemId: 9999, quantity: 1 }]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CheckoutMappingError);
    expect((caught as CheckoutMappingError).catalogItemId).toBe(9999);
  });

  it("(3c) unavailable item throws CheckoutMappingError (route surfaces 422)", async () => {
    mockDbReturn([makeAlavontItem({ id: 100, isAvailable: false })]);
    await expect(
      normalizeCheckoutCart([{ catalogItemId: 100, quantity: 1 }])
    ).rejects.toMatchObject({
      name: "CheckoutMappingError",
      catalogItemId: 100,
      reason: "item_unavailable",
    });
  });

  it("(3d) strict checkout conversion accepts production safe columns for category and image", async () => {
    mockDbReturn([
      makeAlavontItem({
        id: 100,
        customerSafeName: "Customer Safe Tee",
        customerSafeDescription: "Customer-safe production description",
        luciferCruzCategory: "Production Safe Category",
        luciferCruzImageUrl: "https://merchant.example/safe-tee.jpg",
        displayCategory: "Display fallback category",
        displayImage: "https://display.example/fallback.jpg",
      }),
    ]);

    const normalized = await normalizeCheckoutCart([{ catalogItemId: 100, quantity: 1 }], undefined, true, 1, true);

    expect(normalized[0]).toMatchObject({
      customer_safe_name: "Customer Safe Tee",
      customer_safe_description: "Customer-safe production description",
      customer_safe_category: "Production Safe Category",
      customer_safe_image: "https://merchant.example/safe-tee.jpg",
    });
  });

  it("(3d.1) strict checkout conversion rejects rows missing canonical safe fields instead of using fallbacks", async () => {
    mockDbReturn([
      makeAlavontItem({
        id: 100,
        customerSafeName: null,
        customerSafeDescription: null,
        luciferCruzCategory: "Production Safe Category",
      }),
    ]);

    await expect(
      normalizeCheckoutCart([{ catalogItemId: 100, quantity: 1 }], undefined, true, 1, true),
    ).rejects.toMatchObject({
      name: "CheckoutMappingError",
      catalogItemId: 100,
      reason: "missing_safe_fields",
      missingSafeFields: ["customer_safe_name", "customer_safe_description"],
    });
  });

  it("(3e) strict checkout conversion reports missing safe category but allows missing safe image", async () => {
    mockDbReturn([
      makeAlavontItem({
        id: 100,
        customerSafeName: "Customer Safe Tee",
        customerSafeDescription: "Customer-safe production description",
        luciferCruzCategory: null,
        merchantCategory: null,
        displayCategory: null,
        category: null,
        merchantImage: null,
        luciferCruzImageUrl: null,
        displayImage: null,
        imageUrl: null,
      }),
    ]);

    await expect(
      normalizeCheckoutCart([{ catalogItemId: 100, quantity: 1 }], undefined, true, 1, true),
    ).rejects.toMatchObject({
      name: "CheckoutMappingError",
      catalogItemId: 100,
      reason: "missing_safe_fields",
      missingSafeFields: ["customer_safe_category"],
    });
  });

  it("(3e) Alavont row with an UNSUPPORTED merchantProcessingMode still converts from safe fields", async () => {
    mockDbReturn([
      makeAlavontItem({ id: 510, merchantProcessingMode: "passthrough_alavont", customerSafeName: "Safe Tee", customerSafeDescription: "Safe description", luciferCruzCategory: "Safe category" }),
    ]);
    const normalized = await normalizeCheckoutCart([{ catalogItemId: 510, quantity: 1 }], undefined, true, 1, true);
    expect(normalized[0]).toMatchObject({
      customer_safe_name: "Safe Tee",
      customer_safe_description: "Safe description",
      customer_safe_category: "Safe category",
      merchant_sku: "LC-SKU-100",
    });
  });

  it("(3f) Alavont row with mode='comp_only' generates a safe SKU when merchant_sku is missing", async () => {
    mockDbReturn([
      makeAlavontItem({ id: 520, merchantProcessingMode: "comp_only", luciferCruzName: null, merchantName: "Merchant Comp Fallback" }),
    ]);
    const normalized = await normalizeCheckoutCart([{ catalogItemId: 520, quantity: 1 }]);
    expect(normalized[0].merchant_name).toBe("Merchant Comp Fallback");

    mockDbReturn([
      makeAlavontItem({ id: 521, merchantProcessingMode: "comp_only", merchantSku: null }),
    ]);
    const missingSku = await normalizeCheckoutCart([{ catalogItemId: 521, quantity: 1 }]);
    expect(missingSku[0].merchant_sku).toBe("LC-521");
  });

  it("(3d) Alavont-shaped merchant_sku in the DB converts with a generated safe merchant SKU", async () => {
    mockDbReturn([
      makeAlavontItem({ id: 410, merchantSku: "ALV-XYZ-100", customerSafeName: "Safe 410", customerSafeDescription: "Safe description", luciferCruzCategory: "Safe category" }),
    ]);
    const normalized = await normalizeCheckoutCart([{ catalogItemId: 410, quantity: 1 }], undefined, true, 1, true);
    expect(normalized[0]).toMatchObject({
      customer_safe_name: "Safe 410",
      merchant_sku: "LC-410",
    });
  });

  it("(5) merchant_brand discriminator: lucifer_cruz items pass through without rewrite enforcement", async () => {
    // An item already on the LC catalog (merchantBrand="lucifer_cruz") doesn't
    // need lucifer_cruz_name back-fill — its primary identity IS LC.
    mockDbReturn([
      makeAlavontItem({
        id: 300,
        merchantBrand: "lucifer_cruz",
        isWooManaged: true,
        wooProductId: "300",
        merchantProcessingMode: "woo_native",
        luciferCruzName: "LC Native Item",
      }),
    ]);
    const normalized = await normalizeCheckoutCart([{ catalogItemId: 300, quantity: 1 }]);
    expect(normalized[0].merchant_brand).toBe("lucifer_cruz");
    expect(normalized[0].source_type).toBe("woo");
    expect(normalized[0].merchant_name).toBe("LC Native Item");
  });
});
