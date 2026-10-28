import { describe, expect, it } from "vitest";
import {
  assertFiniteCloseoutFinancials,
  calculateCsrDeliveryShareCents,
  calculateCloseoutFinancials,
  formatMoneyCents,
  sumCommissionableDiscountedProductSales,
  sumCustomerTipsForShift,
  ShiftCloseoutFinancialError,
} from "../shiftCloseoutFinancials";

const zeroRevenue = (overrides: Record<string, unknown> = {}) => calculateCloseoutFinancials({
  totalRevenue: "0.00",
  cashSales: "0.00",
  compSales: undefined,
  employeeDiscountSales: "0.00",
  cashBankStart: "100.00",
  cashBankEndReported: "100.00",
  differenceAmount: "0.00",
  tipPercent: 15,
  ...overrides,
});

describe("shift closeout financials", () => {
  it("handles Shift 13's zero-revenue, zero-cash, absent-comp aggregate entirely in cents", () => {
    const result = zeroRevenue();
    expect(result).toMatchObject({
      totalRevenue: 0, cashSales: 0, compSales: 0, qualifyingSales: 0, eligibleSalesBase: 0,
      tipAmount: 0, finalTip: 0, depositAmount: 0, newCashBalance: 0,
    });
    expect(result.persistence).toMatchObject({
      qualifyingSales: "0.00", commissionBasis: "0.00", commissionAmount: "0.00",
      tipAmount: "0.00", depositAmount: "0.00",
    });
  });

  it("treats an explicit compSales zero exactly like an absent no-row aggregate", () => {
    expect(zeroRevenue({ compSales: "0.00" })).toMatchObject({ compSales: 0, tipAmount: 0, depositAmount: 0 });
  });

  it("keeps zero cash sales and the verified $100 bank at a zero deposit", () => {
    expect(zeroRevenue({ cashSales: "0.00", cashBankStart: "100.00", cashBankEndReported: "100.00" })).toMatchObject({ depositAmount: 0 });
  });

  it("produces a zero tip and zero commission when qualifying sales are zero", () => {
    const result = zeroRevenue();
    expect(result).toMatchObject({ tipAmount: 0, finalTip: 0 });
    expect(result.persistence.commissionAmount).toBe("0.00");
  });

  it("uses positive comps in qualifying-sales and commission calculations", () => {
    const result = zeroRevenue({ totalRevenue: "100.00", cashSales: "100.00", compSales: "20.00", cashBankStart: "0.00", cashBankEndReported: "0.00" });
    expect(result).toMatchObject({ qualifyingSales: 80, eligibleSalesBase: 80, tipAmount: 12, finalTip: 12, depositAmount: 88 });
    expect(result.persistence).toMatchObject({ qualifyingSales: "80.00", commissionBasis: "80.00", commissionAmount: "12.00" });
  });

  it("bases commission on paid discounted product subtotal, excluding General Queue, comp, delivery, tax, and tips", () => {
    const base = sumCommissionableDiscountedProductSales([
      { paymentStatus: "paid", paymentMethod: "paypal", routeSource: "active_csr", subtotal: "86.40" },
      { paymentStatus: "paid", paymentMethod: "paypal", routeSource: "general_account", subtotal: "50.00" },
      { paymentStatus: "paid", paymentMethod: "comp", routeSource: "active_csr", subtotal: "20.00" },
      { paymentStatus: "unpaid", paymentMethod: "cash", routeSource: "active_csr", subtotal: "10.00" },
    ]);
    const result = zeroRevenue({
      totalRevenue: "118.00", cashSales: "118.00", compSales: "20.00",
      commissionSalesBase: formatMoneyCents(base), customerTips: "12.00", csrDeliveryEarnings: "0.00",
      cashBankStart: "0.00", cashBankEndReported: "0.00", tipPercent: 17,
    });
    expect(result).toMatchObject({ commissionSalesBase: 86.4, eligibleSalesBase: 86.4, tipAmount: 14.69, customerTips: 12, totalCsrPayout: 26.69 });
    expect(result.depositAmount).toBe(91.31);
  });

  it("pays customer tips in full and adds the completed CSR delivery share at closeout", () => {
    const tips = sumCustomerTipsForShift([
      { paymentStatus: "paid", routeSource: "active_csr", checkoutConversionSnapshot: { tip: { amount: "4.25" } } },
      { paymentStatus: "paid", routeSource: "general_account", checkoutConversionSnapshot: { tip: { amount: "9.00" } } },
      { paymentStatus: "unpaid", routeSource: "active_csr", checkoutConversionSnapshot: { tip: { amount: "6.00" } } },
    ]);
    const result = zeroRevenue({
      totalRevenue: "40.00", cashSales: "40.00", commissionSalesBase: "20.00", compSales: "0.00",
      employeeDiscountSales: "0.00", customerTips: formatMoneyCents(tips), csrDeliveryEarnings: "8.00",
      cashBankStart: "0.00", cashBankEndReported: "0.00", tipPercent: 15,
    });
    expect(result).toMatchObject({ tipAmount: 3, customerTips: 4.25, csrDeliveryEarnings: 8, totalCsrPayout: 15.25, depositAmount: 24.75 });
  });

  it("computes the CSR delivery share as 80 percent with cent rounding", () => {
    expect(formatMoneyCents(calculateCsrDeliveryShareCents("6.25"))).toBe("5.00");
    expect(formatMoneyCents(calculateCsrDeliveryShareCents("10.01"))).toBe("8.01");
  });

  it("rejects an invalid commission base, tip total, delivery amount, or fee", () => {
    expect(() => zeroRevenue({ commissionSalesBase: "-1.00" })).toThrow(/cannot be negative/);
    expect(() => zeroRevenue({ customerTips: "NaN" })).toThrow(/decimal monetary/);
    expect(() => zeroRevenue({ csrDeliveryEarnings: "-0.01" })).toThrow(/cannot be negative/);
    expect(() => calculateCsrDeliveryShareCents("1.005")).toThrow(/decimal monetary/);
  });

  it("rejects malformed monetary aggregates instead of coercing them to zero", () => {
    for (const malformed of [NaN, Infinity, -Infinity, "not-money", {}, []]) {
      expect(() => zeroRevenue({ compSales: malformed })).toThrow(ShiftCloseoutFinancialError);
    }
  });

  it("rejects malformed required money even when the aggregate is otherwise zero", () => {
    expect(() => zeroRevenue({ cashSales: NaN })).toThrow(/finite/);
    expect(() => zeroRevenue({ totalRevenue: "1.234" })).toThrow(/decimal monetary/);
  });

  it("rejects NaN before it can reach any closeout arithmetic", () => {
    expect(() => zeroRevenue({ totalRevenue: NaN })).toThrow(/finite/);
  });

  it("rejects Infinity before it can reach any closeout arithmetic", () => {
    expect(() => zeroRevenue({ cashSales: Infinity })).toThrow(/finite/);
  });

  it("rejects inconsistent financial source records fail-closed", () => {
    expect(() => zeroRevenue({ totalRevenue: "5.00", compSales: "6.00" })).toThrow(/cannot exceed/);
    expect(() => zeroRevenue({ totalRevenue: "5.00", employeeDiscountSales: "6.00" })).toThrow(/cannot exceed/);
  });

  it("never accepts NaN in a persistence-bound closeout object", () => {
    const valid = zeroRevenue();
    expect(() => assertFiniteCloseoutFinancials({ ...valid, tipAmount: NaN })).toThrow(/finite/);
  });

  it("never accepts Infinity in a persistence-bound closeout object", () => {
    const valid = zeroRevenue();
    expect(() => assertFiniteCloseoutFinancials({ ...valid, depositAmount: Infinity })).toThrow(/finite/);
    expect(() => assertFiniteCloseoutFinancials({ ...valid, persistence: { ...valid.persistence, commissionAmount: "NaN" } })).toThrow(ShiftCloseoutFinancialError);
  });
});
