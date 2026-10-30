import { describe, expect, it, vi } from "vitest";
import type { NormalizedCartLine } from "../checkoutNormalizer";
import {
  CartItemUnavailableError,
  isWooEntityOrderable,
  isWooMappingOrderable,
  requireCartLinesAvailable,
  WooAvailabilityProviderError,
} from "../cartAvailability";

function line(source: "woo" | "local_mapped", overrides: Partial<NormalizedCartLine> = {}): NormalizedCartLine {
  return {
    catalog_item_id: 42,
    original_catalog_item_id: 42,
    source_type: source,
    quantity: 1,
    woo_product_id: source === "woo" ? "900" : null,
    woo_variation_id: null,
    ...overrides,
  } as NormalizedCartLine;
}

describe("cart inventory authority", () => {
  it("orders a Woo-managed item with no MyOrder balance without consulting the local ledger", async () => {
    const requireWoo = vi.fn(async () => {});
    const inspectLocal = vi.fn(async () => { throw new Error("missing balance"); });
    await expect(requireCartLinesAvailable([line("woo")], 7, { includeLocal: true }, { requireWoo, inspectLocal }))
      .resolves.toBeUndefined();
    expect(requireWoo).toHaveBeenCalledWith(7, expect.objectContaining({ wooProductId: "900", wooVariationId: null }));
    expect(inspectLocal).not.toHaveBeenCalled();
  });

  it("rejects Woo out-of-stock products when backorders are disabled", () => {
    expect(isWooEntityOrderable({ purchasable: true, status: "publish", stock_status: "outofstock", backorders: "no", backorders_allowed: false }, 1)).toBe(false);
    expect(isWooEntityOrderable({ purchasable: false, status: "publish", stock_status: "instock" }, 1)).toBe(false);
  });

  it.each(["yes", "notify"])("accepts Woo backorder rule %s even without on-hand stock", backorders => {
    expect(isWooEntityOrderable({
      purchasable: true, status: "publish", stock_status: "onbackorder",
      manage_stock: true, stock_quantity: 0, backorders,
    }, 3)).toBe(true);
  });

  it("honors managed Woo quantity when backorders are disabled", () => {
    const entity = { purchasable: true, status: "publish", stock_status: "instock", manage_stock: true, stock_quantity: 1, backorders: "no" };
    expect(isWooEntityOrderable(entity, 1)).toBe(true);
    expect(isWooEntityOrderable(entity, 2)).toBe(false);
  });

  it("checks the exact mapped Woo variation", async () => {
    const requireWoo = vi.fn(async () => {});
    await requireCartLinesAvailable([line("woo", { woo_product_id: "900", woo_variation_id: "901", quantity: 2 })],
      7, { includeLocal: false }, { requireWoo, inspectLocal: vi.fn() });
    expect(requireWoo).toHaveBeenCalledWith(7, {
      catalogItemId: 42, wooProductId: "900", wooVariationId: "901", quantity: 2,
    });
  });

  it("rejects an out-of-stock mapped variation even when its parent is purchasable", () => {
    const product = { purchasable: true, status: "publish", stock_status: "instock" };
    const variation = { purchasable: true, status: "publish", stock_status: "outofstock", backorders: "no" };
    expect(isWooMappingOrderable(product, variation, 1)).toBe(false);
    expect(isWooMappingOrderable(product, { ...variation, stock_status: "onbackorder", backorders: "notify" }, 1)).toBe(true);
  });

  it("combines duplicate Woo cart lines before checking provider quantity", async () => {
    const requireWoo = vi.fn(async () => {});
    await requireCartLinesAvailable([line("woo", { quantity: 1 }), line("woo", { quantity: 2 })],
      7, { includeLocal: false }, { requireWoo, inspectLocal: vi.fn() });
    expect(requireWoo).toHaveBeenCalledOnce();
    expect(requireWoo).toHaveBeenCalledWith(7, expect.objectContaining({ quantity: 3 }));
  });

  it("surfaces provider failures as a retryable availability error", async () => {
    const failure = new WooAvailabilityProviderError();
    await expect(requireCartLinesAvailable([line("woo")], 7, { includeLocal: false }, {
      requireWoo: vi.fn(async () => { throw failure; }), inspectLocal: vi.fn(),
    })).rejects.toMatchObject({ status: 503, code: "WOO_AVAILABILITY_UNAVAILABLE" });
    expect(failure.message).toMatch(/try again/i);
  });

  it("keeps locally managed products with missing balances unavailable", async () => {
    const inspectLocal = vi.fn(async (_tenantId: number, catalogItemId: number) => {
      throw new CartItemUnavailableError(catalogItemId, "This locally managed item has no active sellable inventory balance.");
    });
    await expect(requireCartLinesAvailable([line("local_mapped")], 7, { includeLocal: true }, {
      requireWoo: vi.fn(), inspectLocal,
    })).rejects.toMatchObject({ status: 409, catalogItemId: 42 });
    expect(inspectLocal).toHaveBeenCalledOnce();
  });
});
