import { describe, expect, it } from "vitest";
import { generateVariantCombinations, parseVariantAxes } from "../variantCombinations";

describe("variant option combinations", () => {
  it("generates all Color and Size combinations", () => {
    expect(generateVariantCombinations(parseVariantAxes("Color=Red,Blue; Size=S,M"))).toEqual([
      { Color: "Red", Size: "S" }, { Color: "Red", Size: "M" },
      { Color: "Blue", Size: "S" }, { Color: "Blue", Size: "M" },
    ]);
  });
  it("accepts a simple comma-separated single axis", () => {
    expect(generateVariantCombinations(parseVariantAxes("Small, Medium, Large"))).toEqual([
      { Option: "Small" }, { Option: "Medium" }, { Option: "Large" },
    ]);
  });
  it.each(["Color=Red,Red", "Color=Red; color=Blue", "Color=", "=Red", "Small,,Large", "Small,Small"])("rejects malformed option combinations: %s", input => {
    expect(() => parseVariantAxes(input)).toThrow();
  });
  it("caps generated combinations to prevent accidental cartesian explosion", () => {
    const values = Array.from({ length: 23 }, (_, index) => String(index + 1)).join(",");
    expect(() => parseVariantAxes(`A=${values}; B=${values}`)).toThrow("at most 500 variants");
  });
});
