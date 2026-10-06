import { describe, expect, it } from "vitest";
import { buildSalesTaxReportFromRows, type TaxReportOrder } from "../salesTaxReport";

const row = (overrides: Partial<TaxReportOrder> = {}): TaxReportOrder => ({ id: 1, total: 21.75, grossSales: 20, discounts: 0, taxableSales: 20, nonTaxableSales: 0, taxCalculated: 1.75, taxCollected: 1.75, taxRefunded: 0, jurisdiction: "Sacramento", taxRate: 0.0875, paymentMethod: "cash", customerCreditApplied: 0, voided: false, refundAmount: 0, ...overrides });

describe("sales-tax liability reconciliation", () => {
  it("keeps tax out of gross sales and reconciles tenders", () => {
    const report = buildSalesTaxReportFromRows([row(), row({ id: 2, paymentMethod: "customer_credit+paypal", customerCreditApplied: 10 })]);
    expect(report.grossSales).toBe(40); expect(report.salesTaxCollected).toBe(3.5); expect(report.netSalesTaxLiability).toBe(3.5);
    expect(report.cashSales).toBe(21.75); expect(report.customerCreditApplied).toBe(10); expect(report.splitTenderSales).toBe(21.75); expect(report.reconciled).toBe(true);
  });
  it("subtracts refunded tax without reducing the original taxable sale", () => {
    const report = buildSalesTaxReportFromRows([row({ taxRefunded: 0.88, refundAmount: 10.88 })]);
    expect(report.taxableSales).toBe(20); expect(report.salesTaxRefunded).toBe(0.88); expect(report.netSalesTaxLiability).toBe(0.87);
  });
});
