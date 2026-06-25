import { describe, expect, it } from "vitest";
import { createVerifiedCheckoutConversionToken, requireVerifiedCheckoutConversion, CHECKOUT_CONVERSION_REQUIRED_MESSAGE, signCheckoutConversion } from "../checkoutConversionGate";
import { buildSafeMerchantPayloadLines, assertSafeMerchantLines } from "../merchantPayloadValidator";
import type { NormalizedCartLine } from "../checkoutNormalizer";

const safeLine: NormalizedCartLine = {
  catalog_item_id: 1, source_type: "local_mapped", merchant_brand: "alavont", catalog_display_name: "Alavont OG", merchant_name: "Safe Name", merchant_sku: "SAFE-1", display_name: "Alavont OG", display_description: "Alavont private desc", display_category: "Alavont private cat", display_image: "alavont.png", merchant_brand_name: "Safe", marketing_copy: "Safe copy", customer_safe_name: "Safe Name", customer_safe_description: "Safe Description", customer_safe_category: "Safe Category", customer_safe_image: "safe.png", upsell_copy: null, promo_badges: [], receipt_alavont_name: "Alavont OG", receipt_lucifer_name: "Safe Name", merchant_image_url: "safe.png", unit_price: 10, quantity: 2, line_subtotal: 20, alavont_id: "ALV-1", woo_product_id: null, woo_variation_id: null, lab_name: null, receipt_name: null, label_name: null,
};

describe("checkout conversion gate unit invariants", () => {
  it("rejects missing token", async () => {
    await expect(requireVerifiedCheckoutConversion({ tenantId: 1, userId: 2, requestedItems: [{ catalogItemId: 1, quantity: 2 }], legalDisclaimerAccepted: true, finalConfirmationAt: new Date().toISOString(), snapshot: { ok: true } })).rejects.toThrow(CHECKOUT_CONVERSION_REQUIRED_MESSAGE);
  });

  it("rejects token mismatch", async () => {
    const snapshot = { ok: true };
    const token = await createVerifiedCheckoutConversionToken({ tenantId: 1, userId: 2, items: [{ catalogItemId: 1, quantity: 2 }], snapshot });
    await expect(requireVerifiedCheckoutConversion({ tenantId: 1, userId: 999, checkoutConversionToken: token.checkoutConversionToken, requestedItems: [{ catalogItemId: 1, quantity: 2 }], legalDisclaimerAccepted: true, finalConfirmationAt: new Date().toISOString(), snapshot })).rejects.toThrow(CHECKOUT_CONVERSION_REQUIRED_MESSAGE);
  });

  it("rejects expired conversion", async () => {
    const snapshot = { ok: true };
    const checkoutConversionToken = signCheckoutConversion({ tenantId: 1, userId: 2, issuedAt: new Date(Date.now() - 2000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString(), items: [{ catalogItemId: 1, quantity: 2 }], snapshotHash: "x".repeat(64) });
    await expect(requireVerifiedCheckoutConversion({ tenantId: 1, userId: 2, checkoutConversionToken, requestedItems: [{ catalogItemId: 1, quantity: 2 }], legalDisclaimerAccepted: true, finalConfirmationAt: new Date().toISOString(), snapshot })).rejects.toThrow(CHECKOUT_CONVERSION_REQUIRED_MESSAGE);
  });

  it("rejects changed item quantity and item id", async () => {
    const snapshot = { ok: true };
    const token = await createVerifiedCheckoutConversionToken({ tenantId: 1, userId: 2, items: [{ catalogItemId: 1, quantity: 2 }], snapshot });
    await expect(requireVerifiedCheckoutConversion({ tenantId: 1, userId: 2, checkoutConversionToken: token.checkoutConversionToken, requestedItems: [{ catalogItemId: 1, quantity: 3 }], legalDisclaimerAccepted: true, finalConfirmationAt: new Date().toISOString(), snapshot })).rejects.toThrow(CHECKOUT_CONVERSION_REQUIRED_MESSAGE);
    await expect(requireVerifiedCheckoutConversion({ tenantId: 1, userId: 2, checkoutConversionToken: token.checkoutConversionToken, requestedItems: [{ catalogItemId: 9, quantity: 2 }], legalDisclaimerAccepted: true, finalConfirmationAt: new Date().toISOString(), snapshot })).rejects.toThrow(CHECKOUT_CONVERSION_REQUIRED_MESSAGE);
  });
});

describe("safe merchant payload validator", () => {
  it("rejects missing safe fields", () => {
    expect(() => assertSafeMerchantLines([{ ...safeLine, customer_safe_category: "", customer_safe_image: "" }])).toThrow("Missing safe merchant field: customer_safe_category");
    try {
      assertSafeMerchantLines([{ ...safeLine, customer_safe_category: "", customer_safe_image: "" }]);
    } catch (error) {
      expect(error).toMatchObject({ missingSafeFields: ["customer_safe_category"] });
    }
  });

  it("uses Safe fields only and ignores Alavont fields", () => {
    const payload = buildSafeMerchantPayloadLines([{ ...safeLine, customer_safe_name: "Safe Only" }]);
    expect(payload[0]).toMatchObject({ name: "Safe Only", description: "Safe Description", category: "Safe Category", image_url: "safe.png" });
    expect(JSON.stringify(payload)).not.toContain("Alavont OG");
    expect(JSON.stringify(payload)).not.toContain("Alavont private");
  });

  it("allows missing safe image", () => {
    expect(() => assertSafeMerchantLines([{ ...safeLine, customer_safe_image: null }])).not.toThrow();
    const payload = buildSafeMerchantPayloadLines([{ ...safeLine, customer_safe_image: null }]);
    expect(payload[0].image_url).toBeNull();
  });
});
