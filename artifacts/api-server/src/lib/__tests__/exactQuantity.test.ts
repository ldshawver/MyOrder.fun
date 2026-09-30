import { describe, expect, it } from "vitest";
import { quantityText, quantityUnits } from "../exactQuantity";

describe("exact physical quantities", () => {
  it("adds and subtracts six decimal quantities exactly", () => {
    expect(quantityText(quantityUnits("0.1") + quantityUnits("0.2"))).toBe("0.300000");
    expect(quantityText(quantityUnits("1000") - quantityUnits("250.000001"))).toBe("749.999999");
  });
  it("rejects excess precision and invalid values", () => {
    expect(() => quantityUnits("0.0000001")).toThrow();
    expect(() => quantityUnits("-1")).toThrow();
  });
});
