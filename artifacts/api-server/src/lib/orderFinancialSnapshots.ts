export type CashDiscountConfig = { enabled: boolean; type: "percentage" | "fixed"; value: number };

export function computeOrderFinancialSnapshot(input: {
  grossSubtotal: number; taxRate: number; taxMode: "added" | "included"; tender: string;
  cashDiscount: CashDiscountConfig; capturedAt?: string; taxableSubtotal?: number; nonTaxableSubtotal?: number;
  taxJurisdiction?: string; taxConfigurationId?: number;
}) {
  const configuredValue = Number.isFinite(input.cashDiscount.value) ? Math.max(0, input.cashDiscount.value) : 0;
  const eligible = input.tender === "cash" && input.cashDiscount.enabled;
  const rawDiscount = !eligible ? 0 : input.cashDiscount.type === "fixed"
    ? configuredValue : input.grossSubtotal * Math.min(100, configuredValue) / 100;
  const cashDiscountAmount = Math.round(Math.min(input.grossSubtotal, rawDiscount) * 100) / 100;
  const preDiscountTaxable = input.taxableSubtotal ?? input.grossSubtotal;
  const preDiscountNonTaxable = input.nonTaxableSubtotal ?? Math.max(0, input.grossSubtotal - preDiscountTaxable);
  const taxableDiscount = input.grossSubtotal === 0 ? 0 : Math.round(cashDiscountAmount * preDiscountTaxable / input.grossSubtotal * 100) / 100;
  const nonTaxableDiscount = cashDiscountAmount - taxableDiscount;
  const taxableSubtotal = Math.round((preDiscountTaxable - taxableDiscount) * 100) / 100;
  const nonTaxableSubtotal = Math.round((preDiscountNonTaxable - nonTaxableDiscount) * 100) / 100;
  const taxCollected = input.taxMode === "included"
    ? Math.round((taxableSubtotal - taxableSubtotal / (1 + input.taxRate)) * 100) / 100
    : Math.round(taxableSubtotal * input.taxRate * 100) / 100;
  const merchandiseTotal = input.taxMode === "included" ? Math.round((taxableSubtotal + nonTaxableSubtotal) * 100) / 100 : Math.round((taxableSubtotal + nonTaxableSubtotal + taxCollected) * 100) / 100;
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  return {
    taxableSubtotal, taxCollected, merchandiseTotal, cashDiscountAmount,
    nonTaxableSubtotal,
    taxSnapshot: { schemaVersion: 2, jurisdiction: input.taxJurisdiction ?? null, taxConfigurationId: input.taxConfigurationId ?? null, taxMode: input.taxMode, taxRate: input.taxRate, grossSubtotal: input.grossSubtotal, taxableSubtotal, nonTaxableSubtotal, discounts: cashDiscountAmount, taxCalculated: taxCollected, taxCollected, roundingPolicy: "round_half_away_from_zero_per_order", tender: input.tender, exemptionReason: null, capturedAt },
    cashDiscountSnapshot: { schemaVersion: 1, enabled: input.cashDiscount.enabled, applied: cashDiscountAmount > 0, type: input.cashDiscount.type, configuredValue, amount: cashDiscountAmount, tender: input.tender, capturedAt },
  };
}
