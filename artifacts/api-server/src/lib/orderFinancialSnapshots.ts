export type CashDiscountConfig = { enabled: boolean; type: "percentage" | "fixed"; value: number };

export function computeOrderFinancialSnapshot(input: {
  grossSubtotal: number; taxRate: number; taxMode: "added" | "included"; tender: string;
  cashDiscount: CashDiscountConfig; capturedAt?: string;
}) {
  const configuredValue = Number.isFinite(input.cashDiscount.value) ? Math.max(0, input.cashDiscount.value) : 0;
  const eligible = input.tender === "cash" && input.cashDiscount.enabled;
  const rawDiscount = !eligible ? 0 : input.cashDiscount.type === "fixed"
    ? configuredValue : input.grossSubtotal * Math.min(100, configuredValue) / 100;
  const cashDiscountAmount = Math.round(Math.min(input.grossSubtotal, rawDiscount) * 100) / 100;
  const taxableSubtotal = Math.round((input.grossSubtotal - cashDiscountAmount) * 100) / 100;
  const taxCollected = input.taxMode === "included"
    ? Math.round((taxableSubtotal - taxableSubtotal / (1 + input.taxRate)) * 100) / 100
    : Math.round(taxableSubtotal * input.taxRate * 100) / 100;
  const merchandiseTotal = input.taxMode === "included" ? taxableSubtotal : Math.round((taxableSubtotal + taxCollected) * 100) / 100;
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  return {
    taxableSubtotal, taxCollected, merchandiseTotal, cashDiscountAmount,
    taxSnapshot: { schemaVersion: 1, jurisdiction: null, taxMode: input.taxMode, taxRate: input.taxRate, grossSubtotal: input.grossSubtotal, taxableSubtotal, nonTaxableSubtotal: 0, discounts: cashDiscountAmount, taxCollected, tender: input.tender, exemptionReason: null, capturedAt },
    cashDiscountSnapshot: { schemaVersion: 1, enabled: input.cashDiscount.enabled, applied: cashDiscountAmount > 0, type: input.cashDiscount.type, configuredValue, amount: cashDiscountAmount, tender: input.tender, capturedAt },
  };
}
