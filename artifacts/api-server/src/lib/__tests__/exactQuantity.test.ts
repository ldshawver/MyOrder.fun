import { describe, expect, it } from "vitest";
import { ledgerQuantityUnits, quantityText, quantityUnits } from "../exactQuantity";

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

describe("ledger quantities", () => {
  it("accepts signed totals when the excess ledger scale is zero", () => {
    expect(ledgerQuantityUnits("-1.000000000000")).toBe(-1000000n);
    expect(ledgerQuantityUnits("3.500000000000")).toBe(3500000n);
  });

  it("rejects nonzero precision beyond the physical six-place scale", () => {
    expect(() => ledgerQuantityUnits("1.0000001")).toThrow(/precision/);
    expect(() => ledgerQuantityUnits("-1.0000001")).toThrow(/precision/);
  });
});
