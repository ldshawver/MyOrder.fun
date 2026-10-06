export type TaxReportOrder = {
  id: number; total: number; grossSales: number; discounts: number; taxableSales: number; nonTaxableSales: number;
  taxCalculated: number; taxCollected: number; taxRefunded: number; jurisdiction: string; taxRate: number;
  paymentMethod: string; customerCreditApplied: number; voided: boolean; refundAmount: number;
};

const round = (value: number) => Math.round(value * 100) / 100;

export function buildSalesTaxReportFromRows(rows: TaxReportOrder[]) {
  const sum = (pick: (row: TaxReportOrder) => number) => round(rows.reduce((total, row) => total + pick(row), 0));
  const jurisdictionMap = new Map<string, { jurisdiction: string; taxRate: number; taxableAmount: number; taxCalculated: number; taxCollected: number; taxRefunded: number }>();
  for (const row of rows) {
    const key = `${row.jurisdiction}:${row.taxRate}`;
    const item = jurisdictionMap.get(key) ?? { jurisdiction: row.jurisdiction, taxRate: row.taxRate, taxableAmount: 0, taxCalculated: 0, taxCollected: 0, taxRefunded: 0 };
    item.taxableAmount = round(item.taxableAmount + row.taxableSales); item.taxCalculated = round(item.taxCalculated + row.taxCalculated);
    item.taxCollected = round(item.taxCollected + row.taxCollected); item.taxRefunded = round(item.taxRefunded + row.taxRefunded); jurisdictionMap.set(key, item);
  }
  const taxCalculated = sum(row => row.taxCalculated); const taxCollected = sum(row => row.taxCollected); const taxRefunded = sum(row => row.taxRefunded);
  const reconciliationDifference = round(taxCollected - taxRefunded - (taxCalculated - taxRefunded));
  const tender = (name: string) => sum(row => row.paymentMethod === name ? row.total : 0);
  return {
    grossSales: sum(row => row.grossSales), discounts: sum(row => row.discounts), taxableSales: sum(row => row.taxableSales),
    nontaxableSales: sum(row => row.nonTaxableSales), taxableAmount: sum(row => row.taxableSales), salesTaxCalculated: taxCalculated,
    salesTaxCollected: taxCollected, salesTaxRefunded: taxRefunded, netSalesTaxLiability: round(taxCollected - taxRefunded),
    cashSales: tender("cash"), paypalWalletSales: tender("paypal"), paypalCardSales: tender("paypal_card"),
    customerCreditApplied: sum(row => row.customerCreditApplied), splitTenderSales: sum(row => row.paymentMethod.includes("+customer_credit") || row.paymentMethod.startsWith("customer_credit+") ? row.total : 0),
    voids: rows.filter(row => row.voided).length, fullRefunds: rows.filter(row => row.refundAmount >= row.total && row.total > 0).length,
    partialRefunds: rows.filter(row => row.refundAmount > 0 && row.refundAmount < row.total).length,
    discrepancy: reconciliationDifference, reconciled: reconciliationDifference === 0,
    jurisdictions: [...jurisdictionMap.values()].sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || a.taxRate - b.taxRate),
    transactions: rows.map(row => ({ orderId: row.id, paymentMethod: row.paymentMethod, total: row.total, taxCalculated: row.taxCalculated, taxCollected: row.taxCollected, taxRefunded: row.taxRefunded })),
  };
}
