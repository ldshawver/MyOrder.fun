import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db and catalogItemsTable
vi.mock("@workspace/db", () => {
  const catalogItemsTable = { id: "catalog_items_id" };
  const db = {
    select: vi.fn(),
  };
  return { db, catalogItemsTable };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import { normalizeCheckoutCart, buildMerchantPayloadLines, buildReceiptLines } from "../checkoutNormalizer";
import { db } from "@workspace/db";

function makeDbMock(item: any) {
  const limit = vi.fn().mockResolvedValue([item]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  (db.select as any).mockReturnValue({ from });
}

function makeSampleLocalMappedItem(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    tenantId: 1,
    name: "Generic Name",
    price: "29.99",
    isAvailable: true,
    isWooManaged: false,
    isLocalAlavont: true,
    merchantProcessingMode: "mapped_lucifer",
    merchantProductSource: "local_mapped",
    alavontName: "Alavont Display Name",
    alavontId: "ALV-001",
    luciferCruzName: "Lucifer Cruz Merchant Name",
    luciferCruzImageUrl: "https://lucifercruz.com/img/product.jpg",
    luciferCruzDescription: "LC description",
    luciferCruzCategory: "Adult",
    labName: "Lab Product A",
    receiptName: null,
    imageUrl: null,
    wooProductId: null,
    wooVariationId: null,
    ...overrides,
  };
}

function makeSampleWooItem(overrides: Record<string, any> = {}) {
  return {
    id: 2,
    tenantId: 1,
    name: "Woo Product",
    price: "49.99",
    isAvailable: true,
    isWooManaged: true,
    isLocalAlavont: false,
    merchantProcessingMode: "woo_native",
    merchantProductSource: "woo",
    alavontName: "Woo Display Name",
    alavontId: "wc_100",
    luciferCruzName: "Woo LC Name",
    luciferCruzImageUrl: "https://lucifercruz.com/img/woo.jpg",
    luciferCruzCategory: "Adult",
    labName: "Woo Lab",
    receiptName: null,
    imageUrl: null,
    wooProductId: "100",
    wooVariationId: null,
    ...overrides,
  };
}

describe("checkoutNormalizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("normalizeCheckoutCart", () => {
    it("classifies a locally-mapped Alavont item as local_mapped", async () => {
      makeDbMock(makeSampleLocalMappedItem());
      const result = await normalizeCheckoutCart([{ catalogItemId: 1, quantity: 2 }]);
      expect(result).toHaveLength(1);
      expect(result[0].source_type).toBe("local_mapped");
      expect(result[0].catalog_display_name).toBe("Alavont Display Name");
      expect(result[0].merchant_name).toBe("Lucifer Cruz Merchant Name");
    });

    it("classifies a WooCommerce-managed item as woo", async () => {
      makeDbMock(makeSampleWooItem());
      const result = await normalizeCheckoutCart([{ catalogItemId: 2, quantity: 1 }]);
      expect(result).toHaveLength(1);
      expect(result[0].source_type).toBe("woo");
      expect(result[0].woo_product_id).toBe("100");
    });

    it("preserves woo_product_id through normalization", async () => {
      makeDbMock(makeSampleWooItem());
      const result = await normalizeCheckoutCart([{ catalogItemId: 2, quantity: 1 }]);
      expect(result[0].woo_product_id).toBe("100");
      expect(result[0].woo_variation_id).toBeNull();
    });

    it("throws when local_mapped item has no lucifer_cruz_name", async () => {
      makeDbMock(makeSampleLocalMappedItem({ luciferCruzName: null }));
      await expect(normalizeCheckoutCart([{ catalogItemId: 1, quantity: 1 }])).rejects.toThrow(
        /missing lucifer_cruz_name/
      );
    });

    it("throws when woo-managed item has no woo_product_id", async () => {
      makeDbMock(makeSampleWooItem({ wooProductId: null }));
      await expect(normalizeCheckoutCart([{ catalogItemId: 2, quantity: 1 }])).rejects.toThrow(
        /missing woo_product_id/
      );
    });

    it("throws when catalog item is not found", async () => {
      const limit = vi.fn().mockResolvedValue([]);
      const where = vi.fn(() => ({ limit }));
      const from = vi.fn(() => ({ where }));
      (db.select as any).mockReturnValue({ from });
      await expect(normalizeCheckoutCart([{ catalogItemId: 999, quantity: 1 }])).rejects.toThrow(
        /not found/
      );
    });
  });

  describe("buildMerchantPayloadLines", () => {
    it("uses lucifer_cruz_name (merchant_name) for local_mapped items — Alavont name never appears", () => {
      const normalized = [
        {
          source_type: "local_mapped" as const,
          catalog_display_name: "Alavont Display Name",
          merchant_name: "Lucifer Cruz Merchant Name",
          receipt_alavont_name: "Alavont Display Name",
          receipt_lucifer_name: "Lucifer Cruz Merchant Name",
          merchant_image_url: "https://img.com/lc.jpg",
          unit_price: 29.99,
          quantity: 2,
          alavont_id: "ALV-001",
          woo_product_id: null,
          woo_variation_id: null,
          lab_name: "Lab A",
        },
      ];
      const lines = buildMerchantPayloadLines(normalized, true);
      expect(lines[0].name).toBe("Lucifer Cruz Merchant Name");
      expect(lines[0].name).not.toBe("Alavont Display Name");
    });

    it("does not include Alavont name in merchant payload for mapped products", () => {
      const normalized = [
        {
          source_type: "local_mapped" as const,
          catalog_display_name: "Alavont Only Name",
          merchant_name: "LC Only Name",
          receipt_alavont_name: "Alavont Only Name",
          receipt_lucifer_name: "LC Only Name",
          merchant_image_url: null,
          unit_price: 10,
          quantity: 1,
          alavont_id: null,
          woo_product_id: null,
          woo_variation_id: null,
          lab_name: null,
        },
      ];
      const lines = buildMerchantPayloadLines(normalized, false);
      const allNames = lines.map(l => l.name).join("|");
      expect(allNames).not.toContain("Alavont Only Name");
    });
  });

  describe("buildReceiptLines", () => {
    const lines = [
      {
        source_type: "local_mapped" as const,
        catalog_display_name: "Alavont Product",
        merchant_name: "LC Product",
        receipt_alavont_name: "Alavont Product",
        receipt_lucifer_name: "LC Product",
        merchant_image_url: null,
        unit_price: 20,
        quantity: 1,
        alavont_id: "ALV-1",
        woo_product_id: null,
        woo_variation_id: null,
        lab_name: "Lab X",
      },
    ];

    it("alavont_only mode shows Alavont name", () => {
      const result = buildReceiptLines(lines, "alavont_only");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Alavont Product");
    });

    it("lucifer_only mode shows LC name", () => {
      const result = buildReceiptLines(lines, "lucifer_only");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("LC Product");
    });

    it("both mode shows Alavont name first + LC secondary line", () => {
      const result = buildReceiptLines(lines, "both");
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0].name).toBe("Alavont Product");
      expect(result[1].name).toBe("LC: LC Product");
      expect(result[1].unit_price).toBe(0);
    });

    it("both mode with same alavont/lucifer name only produces one line", () => {
      const sameNameLines = [{ ...lines[0], receipt_lucifer_name: "Alavont Product" }];
      const result = buildReceiptLines(sameNameLines, "both");
      expect(result).toHaveLength(1);
    });
  });

  describe("mixed cart normalization", () => {
    it("handles a mixed cart (local + woo) correctly", async () => {
      const localItem = makeSampleLocalMappedItem();
      const wooItem = makeSampleWooItem();

      const limit1 = vi.fn().mockResolvedValueOnce([localItem]).mockResolvedValueOnce([wooItem]);
      const where1 = vi.fn(() => ({ limit: limit1 }));
      const from1 = vi.fn(() => ({ where: where1 }));
      (db.select as any).mockReturnValue({ from: from1 });

      const result = await normalizeCheckoutCart([
        { catalogItemId: 1, quantity: 2 },
        { catalogItemId: 2, quantity: 1 },
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].source_type).toBe("local_mapped");
      expect(result[1].source_type).toBe("woo");
    });
  });

  describe("Lucifer toggle filter", () => {
    it("local_mapped items have merchant_name set to lucifer_cruz_name", async () => {
      makeDbMock(makeSampleLocalMappedItem());
      const result = await normalizeCheckoutCart([{ catalogItemId: 1, quantity: 1 }]);
      expect(result[0].merchant_name).toBe("Lucifer Cruz Merchant Name");
    });
  });

  describe("catalog Alavont isolation", () => {
    it("catalog_display_name is the Alavont name — never the LC merchant name", async () => {
      makeDbMock(makeSampleLocalMappedItem());
      const result = await normalizeCheckoutCart([{ catalogItemId: 1, quantity: 1 }]);
      expect(result[0].catalog_display_name).toBe("Alavont Display Name");
      expect(result[0].catalog_display_name).not.toBe("Lucifer Cruz Merchant Name");
    });

    it("catalog_item_id is preserved in the normalized line", async () => {
      makeDbMock(makeSampleLocalMappedItem({ id: 42 }));
      const result = await normalizeCheckoutCart([{ catalogItemId: 42, quantity: 3 }]);
      expect(result[0].catalog_item_id).toBe(42);
      expect(result[0].quantity).toBe(3);
    });

    it("receipt_alavont_name is separate from merchant_name — Alavont brand is isolated", async () => {
      makeDbMock(makeSampleLocalMappedItem());
      const result = await normalizeCheckoutCart([{ catalogItemId: 1, quantity: 1 }]);
      expect(result[0].receipt_alavont_name).toBe("Alavont Display Name");
      expect(result[0].receipt_lucifer_name).toBe("Lucifer Cruz Merchant Name");
      // These must differ — if they're the same, the isolation is broken
      expect(result[0].receipt_alavont_name).not.toBe(result[0].merchant_name.replace(/alavont/i, ""));
    });
  });

  describe("payment route payload safety", () => {
    it("buildMerchantPayloadLines: no Alavont name in any field — woo item", () => {
      const normalized = [
        {
          catalog_item_id: 2,
          source_type: "woo" as const,
          catalog_display_name: "Alavont Woo Display",
          merchant_name: "LC Woo Merchant",
          receipt_alavont_name: "Alavont Woo Display",
          receipt_lucifer_name: "LC Woo Merchant",
          merchant_image_url: "https://img.com/woo.jpg",
          unit_price: 49.99,
          quantity: 1,
          alavont_id: "wc_100",
          woo_product_id: "100",
          woo_variation_id: null,
          lab_name: "Lab Woo",
          receipt_name: null,
          label_name: null,
        },
      ];
      const lines = buildMerchantPayloadLines(normalized);
      expect(lines[0].name).toBe("LC Woo Merchant");
      expect(lines[0].name).not.toContain("Alavont");
      expect(lines[0].woo_product_id).toBe("100");
      expect(lines[0].source_type).toBe("woo");
    });

    it("buildMerchantPayloadLines includes woo_product_id and woo_variation_id for CJ sync", () => {
      const normalized = [
        {
          catalog_item_id: 3,
          source_type: "woo" as const,
          catalog_display_name: "Alavont Var",
          merchant_name: "LC Var",
          receipt_alavont_name: "Alavont Var",
          receipt_lucifer_name: "LC Var",
          merchant_image_url: null,
          unit_price: 25,
          quantity: 2,
          alavont_id: null,
          woo_product_id: "200",
          woo_variation_id: "201",
          lab_name: null,
          receipt_name: null,
          label_name: null,
        },
      ];
      const lines = buildMerchantPayloadLines(normalized);
      expect(lines[0].woo_product_id).toBe("200");
      expect(lines[0].woo_variation_id).toBe("201");
      expect(lines[0].total_price).toBeCloseTo(50);
    });
  });
});
