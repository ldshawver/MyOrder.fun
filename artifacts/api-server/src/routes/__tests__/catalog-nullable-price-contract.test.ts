import { describe, expect, it } from "vitest";
import { GetCatalogItemResponse, UpdateCatalogItemBody } from "@workspace/api-zod";

describe("nullable catalogue amount contract", () => {
  it("accepts a legacy item with no comparison price and preserves null on update", () => {
    const legacy = GetCatalogItemResponse.parse({
      id: 1, tenantId: 1, name: "Legacy item", category: "Test", price: 10,
      compareAtPrice: null, parLevel: null, stockQuantity: 0,
      isAvailable: true, isTaxable: true,
      createdAt: new Date("2026-09-01T00:00:00Z"), updatedAt: new Date("2026-09-01T00:00:00Z"),
    });
    expect(legacy.compareAtPrice).toBeNull();
    expect(UpdateCatalogItemBody.strict().parse({ compareAtPrice: legacy.compareAtPrice, parLevel: legacy.parLevel }))
      .toMatchObject({ compareAtPrice: null, parLevel: null });
    expect(UpdateCatalogItemBody.strict().parse({ compareAtPrice: 12.5 }).compareAtPrice).toBe(12.5);
  });

  it("rejects malformed numbers and unknown update fields", () => {
    expect(UpdateCatalogItemBody.strict().safeParse({ compareAtPrice: "12.50" }).success).toBe(false);
    expect(UpdateCatalogItemBody.strict().safeParse({ compareAtPrice: null, unknownField: true }).success).toBe(false);
  });
});
