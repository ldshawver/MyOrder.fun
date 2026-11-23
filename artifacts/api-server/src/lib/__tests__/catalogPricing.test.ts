import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { catalogAmountError } from "../catalogPricing";

describe("catalog amount write policy", () => {
  it("accepts positive selling prices, nullable alternates, and a zero cost basis", () => {
    expect(catalogAmountError({
      price: 10,
      compareAtPrice: 12.5,
      regularPrice: null,
      homiePrice: 8,
      costBasis: 0,
    })).toBeNull();
  });

  it.each(["price", "compareAtPrice", "regularPrice", "homiePrice"] as const)(
    "rejects non-positive %s values",
    field => {
      expect(catalogAmountError({ [field]: 0 })).toBe(`${field} must be greater than zero`);
      expect(catalogAmountError({ [field]: -0.01 })).toBe(`${field} must be greater than zero`);
    },
  );

  it("rejects negative cost without preventing an unknown cost", () => {
    expect(catalogAmountError({ costBasis: -0.01 })).toBe("costBasis must be zero or greater");
    expect(catalogAmountError({ costBasis: null })).toBeNull();
  });

  it("enforces the amount policy on both catalog create and update writes", () => {
    const route = readFileSync(new URL("../../routes/catalog.ts", import.meta.url), "utf8");
    expect(route.match(/catalogAmountError\(/g)).toHaveLength(2);
    expect(route).toContain("catalogAmountError(body.data)");
    expect(route).toContain("catalogAmountError({ price, compareAtPrice, regularPrice, homiePrice, costBasis })");
  });
});
