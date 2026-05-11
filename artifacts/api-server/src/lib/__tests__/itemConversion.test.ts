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
  const db = { select: vi.fn() };
  return { db, catalogItemsTable };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  normalizeCheckoutCart,
  computeCheckoutTotals,
  CheckoutMappingError,
  CartLineInput,
  CHECKOUT_TAX_RATE,
} from "../checkoutNormalizer";
import {
  buildStripeIntentPayload,
  payloadContainsAlavontLeak,
  LUCIFER_CRUZ_STATEMENT_SUFFIX,
} from "../stripePayload";
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
    expect(totals.taxRate).toBe(CHECKOUT_TAX_RATE);
    expect(totals.tax).toBeCloseTo(totals.subtotal * CHECKOUT_TAX_RATE, 2);
    expect(totals.total).toBeCloseTo(totals.subtotal + totals.tax, 2);

    // Stripe payload now derives from normalized (LC) lines exclusively.
    const stripePayload = buildStripeIntentPayload({
      orderId: 555,
      amount: totals.total,
      currency: "usd",
      lines: normalized,
    });
    expect(stripePayload.description).toContain("LC Premium Tee");
    expect(stripePayload.description).toContain("LC Hat");
    expect(stripePayload.metadata.merchantBrand).toBe("lucifer_cruz");
    expect(stripePayload.statement_descriptor_suffix).toBe(LUCIFER_CRUZ_STATEMENT_SUFFIX);
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
    expect(totals.total).toBeCloseTo(60 + 60 * CHECKOUT_TAX_RATE, 2);
  });

  it("(3) missing Alavont→LC mapping throws CheckoutMappingError with offending catalogItemId", async () => {
    mockDbReturn([makeAlavontItem({ id: 100, luciferCruzName: null })]);

    await expect(
      normalizeCheckoutCart([{ catalogItemId: 100, quantity: 1 }])
    ).rejects.toMatchObject({
      name: "CheckoutMappingError",
      catalogItemId: 100,
      reason: "missing_lucifer_cruz_name",
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

  it("(4) Stripe payload contains ONLY Lucifer Cruz strings — never Alavont", async () => {
    mockDbReturn([
      makeAlavontItem({
        id: 200,
        alavontName: "VeryDistinctAlavontName_X9",
        alavontId: "ALV-DISTINCT-X9",
        luciferCruzName: "LC Standard Hoodie",
        merchantSku: "LC-HOODIE-9",
      }),
    ]);
    const normalized = await normalizeCheckoutCart([{ catalogItemId: 200, quantity: 1 }]);
    const totals = computeCheckoutTotals(normalized);

    const stripePayload = buildStripeIntentPayload({
      orderId: 777,
      amount: totals.total,
      currency: "usd",
      lines: normalized,
    });

    // The full serialized payload must NOT contain the Alavont brand strings.
    const serialized = JSON.stringify(stripePayload);
    expect(serialized).not.toContain("VeryDistinctAlavontName_X9");
    expect(serialized).not.toContain("ALV-DISTINCT-X9");

    // Description, metadata, and statement descriptor are LC-only.
    expect(stripePayload.description).toContain("LC Standard Hoodie");
    expect(stripePayload.metadata.merchantSkus).toContain("LC-HOODIE-9");
    expect(stripePayload.statement_descriptor_suffix).toBe(LUCIFER_CRUZ_STATEMENT_SUFFIX);

    // Explicit per-field assertion: the SKU summary the processor sees never
    // carries the ALV-/ALAVONT- prefix nor the row's alavont_id.
    for (const sku of stripePayload.metadata.merchantSkus.split(",")) {
      expect(sku).not.toMatch(/^(?:ALV|ALAVONT)[-_]/i);
      expect(sku).not.toBe("ALV-DISTINCT-X9");
    }
    expect(stripePayload.metadata.merchantBrand).not.toBe("alavont");

    // Defense-in-depth helper agrees: no leak.
    const leakCheck = payloadContainsAlavontLeak(stripePayload, normalized);
    expect(leakCheck.leaked).toBe(false);
    expect(leakCheck.offenders).toEqual([]);
  });

  it("(4c) Stripe payload sanitizer drops an Alavont-shaped merchant_sku even if one slipped past the catalog layer", () => {
    // Synthesize a normalized line whose merchant_sku looks like an Alavont
    // identifier (a layered failure mode: the normalizer's catalog check was
    // bypassed). The payload builder MUST still refuse to forward it.
    const tainted = [
      {
        catalog_item_id: 88,
        source_type: "local_mapped" as const,
        merchant_brand: "alavont" as const,
        catalog_display_name: "Alavont Item",
        merchant_name: "LC Item",
        merchant_sku: "ALV-FORBIDDEN-88",
        receipt_alavont_name: "Alavont Item",
        receipt_lucifer_name: "LC Item",
        merchant_image_url: null,
        unit_price: 12,
        quantity: 1,
        line_subtotal: 12,
        alavont_id: "ALV-FORBIDDEN-88",
        woo_product_id: null,
        woo_variation_id: null,
        lab_name: null,
        receipt_name: null,
        label_name: null,
      },
    ];
    const payload = buildStripeIntentPayload({ orderId: 88, amount: 12.96, currency: "usd", lines: tainted });
    expect(payload.metadata.merchantSkus).not.toContain("ALV-FORBIDDEN-88");
    expect(payload.metadata.merchantSkus).toBe("cid:88");
  });

  it("(3e) Alavont row with an UNSUPPORTED merchantProcessingMode still 422s — conversion is unconditional on brand", async () => {
    // Reviewer pin: a malicious or drifted row can carry any free-text
    // processing mode. The normalizer must NOT silently fall through to a
    // payment payload — Alavont brand always requires LC mapping enforcement.
    mockDbReturn([
      makeAlavontItem({ id: 510, merchantProcessingMode: "passthrough_alavont" }),
    ]);
    await expect(
      normalizeCheckoutCart([{ catalogItemId: 510, quantity: 1 }])
    ).rejects.toMatchObject({
      name: "CheckoutMappingError",
      catalogItemId: 510,
      reason: "unsupported_processing_mode",
    });
  });

  it("(3f) Alavont row with mode='comp_only' but missing LC mapping still 422s — LC checks are universal", async () => {
    // The supported-modes allowlist passes "comp_only", but LC name +
    // merchant_sku checks must still run for every Alavont row.
    mockDbReturn([
      makeAlavontItem({ id: 520, merchantProcessingMode: "comp_only", luciferCruzName: null }),
    ]);
    await expect(
      normalizeCheckoutCart([{ catalogItemId: 520, quantity: 1 }])
    ).rejects.toMatchObject({
      name: "CheckoutMappingError",
      catalogItemId: 520,
      reason: "missing_lucifer_cruz_name",
    });

    mockDbReturn([
      makeAlavontItem({ id: 521, merchantProcessingMode: "comp_only", merchantSku: null }),
    ]);
    await expect(
      normalizeCheckoutCart([{ catalogItemId: 521, quantity: 1 }])
    ).rejects.toMatchObject({
      name: "CheckoutMappingError",
      catalogItemId: 521,
      reason: "missing_merchant_sku",
    });
  });

  it("(3d) Alavont-shaped merchant_sku in the DB is rejected at the normalizer layer", async () => {
    // Row was wrongly remapped — merchant_sku still carries the Alavont id.
    mockDbReturn([
      makeAlavontItem({ id: 410, merchantSku: "ALV-XYZ-100" }),
    ]);
    await expect(
      normalizeCheckoutCart([{ catalogItemId: 410, quantity: 1 }])
    ).rejects.toMatchObject({
      name: "CheckoutMappingError",
      catalogItemId: 410,
      reason: "alavont_shaped_merchant_sku",
    });
  });

  it("(4b) leak detector flags Alavont strings if a payload were synthesized incorrectly", () => {
    const fakeNormalized = [
      {
        catalog_item_id: 1,
        source_type: "local_mapped" as const,
        merchant_brand: "alavont" as const,
        catalog_display_name: "Alavont Distinct Name 42",
        merchant_name: "LC Real Name",
        merchant_sku: "LC-1",
        receipt_alavont_name: "Alavont Distinct Name 42",
        receipt_lucifer_name: "LC Real Name",
        merchant_image_url: null,
        unit_price: 10,
        quantity: 1,
        line_subtotal: 10,
        alavont_id: "ALV-DISTINCT-42",
        woo_product_id: null,
        woo_variation_id: null,
        lab_name: null,
        receipt_name: null,
        label_name: null,
      },
    ];
    const buggyPayload = {
      amount: 1000,
      currency: "usd",
      description: "Order — Alavont Distinct Name 42 x1",
      metadata: { orderId: "1", merchantBrand: "alavont", merchantLines: "Alavont Distinct Name 42 x1", merchantSkus: "ALV-DISTINCT-42", lineCount: "1" },
      statement_descriptor_suffix: LUCIFER_CRUZ_STATEMENT_SUFFIX,
    };
    const leakCheck = payloadContainsAlavontLeak(buggyPayload, fakeNormalized);
    expect(leakCheck.leaked).toBe(true);
    expect(leakCheck.offenders).toContain("Alavont Distinct Name 42");
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
