import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: { select: vi.fn() },
  taxConfigurationsTable: {
    tenantId: "tenantId", locationId: "locationId", sourcingRule: "sourcingRule",
    effectiveFrom: "effectiveFrom", effectiveUntil: "effectiveUntil",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => ({ and: conditions })),
  eq: vi.fn((column: unknown, value: unknown) => ({ eq: [column, value] })),
  gte: vi.fn((column: unknown, value: unknown) => ({ gte: [column, value] })),
  isNull: vi.fn((column: unknown) => ({ isNull: column })),
  lte: vi.fn((column: unknown, value: unknown) => ({ lte: [column, value] })),
  or: vi.fn((...conditions: unknown[]) => ({ or: conditions })),
}));

import { db } from "@workspace/db";
import { getCheckoutTaxSettings, TaxConfigurationError } from "../checkoutNormalizer";

function selectResult(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn(() => ({ where }));
  return { from };
}

describe("checkout tax configuration resolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("falls back to an effective tenant-wide configuration when no location row exists", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectResult([]) as never)
      .mockReturnValueOnce(selectResult([{
        id: 1, rate: "0.08750000", jurisdiction: "Sacramento, California",
        locationId: null, sourcingRule: "tenant",
      }]) as never);

    await expect(getCheckoutTaxSettings(1, 3, new Date("2026-09-09T00:00:00Z"))).resolves.toEqual({
      taxMode: "added", taxRate: 0.0875, taxJurisdiction: "Sacramento, California", taxConfigurationId: 1,
    });
  });

  it("prefers an effective location-specific configuration over the tenant-wide fallback", async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectResult([{
      id: 9, rate: "0.08250000", jurisdiction: "Local", locationId: 3, sourcingRule: "origin",
    }]) as never);
    await expect(getCheckoutTaxSettings(1, 3)).resolves.toMatchObject({ taxConfigurationId: 9, taxRate: 0.0825 });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("fails closed when neither location nor tenant-wide configuration exists", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectResult([]) as never)
      .mockReturnValueOnce(selectResult([]) as never);
    await expect(getCheckoutTaxSettings(1, 3)).rejects.toBeInstanceOf(TaxConfigurationError);
  });
});
