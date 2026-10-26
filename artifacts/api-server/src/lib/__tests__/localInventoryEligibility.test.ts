import { describe, expect, it } from "vitest";
import { isLocallyManagedSellableCatalogItem } from "../localInventoryEligibility";

const eligible = (overrides: Partial<Parameters<typeof isLocallyManagedSellableCatalogItem>[0]> = {}) => ({
  isAvailable: true,
  isLocalAlavont: true,
  metadata: {},
  ...overrides,
});

describe("local inventory eligibility", () => {
  it.each([
    "LC-PSL-2OZ",
    "LC-PSL-8OZ",
    "LC-PSL-16OZ",
    "Body Linen Spray, Noble Essence — 3 oz",
    "Body Linen Spray, Noble Essence — 4 oz",
    "Scented Candle, Noble Essence",
  ])("keeps sellable Lucifer Cruz exclusive %s eligible regardless of category", () => {
    expect(isLocallyManagedSellableCatalogItem(eligible())).toBe(true);
  });

  it("keeps an explicitly local Woo-listed exclusive eligible", () => {
    expect(isLocallyManagedSellableCatalogItem(eligible())).toBe(true);
  });

  it("excludes Woo/CJ dropship rows not designated for local stock", () => {
    expect(isLocallyManagedSellableCatalogItem(eligible({ isLocalAlavont: false }))).toBe(false);
    expect(isLocallyManagedSellableCatalogItem(eligible({ isLocalAlavont: null }))).toBe(false);
  });

  it.each([
    { isAvailable: false },
    { metadata: { archived: true } },
    { metadata: { complianceHold: true } },
    { metadata: { safeOnlyDuplicate: true } },
    { metadata: { mergedIntoCatalogItemId: 44 } },
  ])("excludes non-sellable lifecycle state %#", override => {
    expect(isLocallyManagedSellableCatalogItem(eligible(override))).toBe(false);
  });
});
