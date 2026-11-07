import { describe, expect, it } from "vitest";
import { resolveEmployeeUnitPriceCents } from "../employeePricing";

describe("employee pricing", () => {
  it("charges retail when the account is not a current employee", () => {
    expect(resolveEmployeeUnitPriceCents("25.00", "10.00", false)).toBe(2500);
    expect(resolveEmployeeUnitPriceCents("25.00", null, false)).toBe(2500);
  });

  it("takes 20% off when a current employee has no product dollar amount", () => {
    expect(resolveEmployeeUnitPriceCents("25.00", null, true)).toBe(2000);
    expect(resolveEmployeeUnitPriceCents("10.01", "", true)).toBe(801);
  });

  it("uses the product dollar amount instead of 20% off", () => {
    expect(resolveEmployeeUnitPriceCents("25.00", "19.50", true)).toBe(1950);
    expect(resolveEmployeeUnitPriceCents("25.00", "0.00", true)).toBe(0);
  });
});
