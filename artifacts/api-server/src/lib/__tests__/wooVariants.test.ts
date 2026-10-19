import { describe, expect, it } from "vitest";
import { wooVariationLabel, wooVariationMetadata, wooVariationOptionValues } from "../wooVariants";

describe("Woo variable-product option mapping", () => {
  it("maps Woo attributes to deterministic Color/Size values without flattening product identity", () => {
    const values = wooVariationOptionValues([
      { name: "Size", option: "Medium" },
      { name: "Color", option: "Blue" },
    ], "481");
    expect(values).toEqual({ Color: "Blue", Size: "Medium" });
    expect(wooVariationLabel(values)).toBe("Color: Blue / Size: Medium");
  });

  it("preserves a stable fallback identity for Woo variations with no attributes", () => {
    expect(wooVariationOptionValues([], "482")).toEqual({ Variation: "482" });
  });

  it("rejects ambiguous duplicate option names instead of silently overwriting a value", () => {
    expect(() => wooVariationOptionValues([
      { name: "Color", option: "Blue" }, { name: "Color", option: "Red" },
    ], "483")).toThrow("duplicate option names");
  });

  it("keeps a parent compliance hold reversible for Woo variations created during the hold", () => {
    const held = wooVariationMetadata({ complianceHold: true, complianceReason: "Review", isVisible: true }, null, 90);
    expect(held).toMatchObject({ complianceHold: true, complianceReason: "Review", complianceProductHoldParentId: 90,
      complianceProductHoldPrevious: { complianceHold: false } });
    const released = wooVariationMetadata({ complianceHold: false, isVisible: true }, held, 90);
    expect(released).toMatchObject({ complianceHold: false, complianceReason: null, isVisible: true });
    expect(released).not.toHaveProperty("complianceProductHoldParentId");
  });

  it("preserves an independently held Woo variation when a parent hold is released", () => {
    const held = wooVariationMetadata({ complianceHold: true, complianceReason: "Parent review" },
      { complianceHold: true, complianceReason: "Variant review" }, 91);
    const released = wooVariationMetadata({ complianceHold: false }, held, 91);
    expect(released).toMatchObject({ complianceHold: true, complianceReason: "Variant review" });
  });
});
