import { describe, expect, it } from "vitest";
import {
  convertQuantity,
  convertUnitCost,
  conversionRatio,
  multiplyQuantity,
  reconciliationFingerprint,
  unitCostForSourceQuantity,
  unitCostPerTargetQuantity,
} from "../catalogueInventoryReconciliation";

describe("catalogue inventory reconciliation arithmetic", () => {
  it("converts exact mass, volume, count and fractional base-unit quantities", () => {
    expect(convertQuantity("1.250000", "kg", "g")).toBe("1250.000000");
    expect(convertQuantity("1250.000000", "g", "kg")).toBe("1.250000");
    expect(convertQuantity("1.500000", "l", "ml")).toBe("1500.000000");
    expect(convertQuantity("2.000000", "pcs", "each")).toBe("2.000000");
    expect(convertQuantity("0.001000", "g", "kg")).toBe("0.000001");
  });

  it("rejects unknown, inexact and cross-family conversions", () => {
    expect(() => convertQuantity("1", "box", "each")).toThrow(/No verified conversion/);
    expect(() => convertQuantity("1", "kg", "ml")).toThrow(/No verified conversion/);
    expect(() => convertQuantity("0.000001", "g", "kg")).toThrow(/exceeds six decimal places/);
    expect(() => conversionRatio("case", "each")).toThrow();
  });

  it("converts positive cost inversely and never uses retail prices", () => {
    expect(convertUnitCost("0.250000000000", "g", "kg")).toBe("250");
    expect(convertUnitCost("250", "kg", "g")).toBe("0.25");
    expect(() => convertUnitCost("0", "g", "kg")).toThrow(/positive/);
  });

  it("uses explicit package weights without treating package counts as grams", () => {
    expect(multiplyQuantity("11", "14")).toBe("154.000000");
    expect(multiplyQuantity("2", "3.5")).toBe("7.000000");
    expect(unitCostPerTargetQuantity("11.10", "3.5")).toBe("3.171428571429");
    expect(unitCostForSourceQuantity("3.171428571429", "3.5")).toBe("11.100000000002");
  });

  it("fingerprints the exact preview snapshot deterministically", () => {
    expect(reconciliationFingerprint({ productId: 1, stock: ["2", "3"] })).toBe(reconciliationFingerprint({ productId: 1, stock: ["2", "3"] }));
    expect(reconciliationFingerprint({ productId: 1, stock: ["2", "4"] })).not.toBe(reconciliationFingerprint({ productId: 1, stock: ["2", "3"] }));
  });
});
