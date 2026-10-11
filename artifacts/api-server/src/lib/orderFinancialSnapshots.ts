import { centsToDollars, computeTenderTaxCents, dollarsToCents, isTransactionTaxedTender } from "./tenderTax";

export type CashDiscountConfig = { enabled: boolean; type: "percentage" | "fixed"; value: number };

const moneyNumber = (cents: number): number => Number(centsToDollars(cents));
const roundRatio = (numerator: bigint, denominator: bigint): number => Number((numerator + denominator / 2n) / denominator);

export function computeOrderFinancialSnapshot(input: {
  grossSubtotal: number; taxRate: number; taxMode: "added" | "included"; tender: string;
  cashDiscount: CashDiscountConfig; capturedAt?: string; taxableSubtotal?: number; nonTaxableSubtotal?: number;
  taxJurisdiction?: string; taxConfigurationId?: number;
}) {
  const grossCents = dollarsToCents(input.grossSubtotal);
  const taxableBeforeDiscountCents = dollarsToCents(input.taxableSubtotal ?? input.grossSubtotal);
  const nonTaxableBeforeDiscountCents = input.nonTaxableSubtotal == null
    ? grossCents - taxableBeforeDiscountCents
    : dollarsToCents(input.nonTaxableSubtotal);
  if (taxableBeforeDiscountCents + nonTaxableBeforeDiscountCents !== grossCents) throw new Error("Merchandise subtotal allocation is inconsistent");
  const configuredValue = Number.isFinite(input.cashDiscount.value) ? Math.max(0, input.cashDiscount.value) : 0;
  const eligible = input.tender === "cash" && input.cashDiscount.enabled;
  const discountCents = !eligible ? 0 : input.cashDiscount.type === "fixed"
    ? Math.min(grossCents, dollarsToCents(configuredValue))
    : Math.min(grossCents, roundRatio(BigInt(grossCents) * BigInt(Math.round(Math.min(100, configuredValue) * 100)), 10000n));
  const taxableDiscountCents = grossCents === 0 ? 0 : roundRatio(BigInt(discountCents) * BigInt(taxableBeforeDiscountCents), BigInt(grossCents));
  const taxableCents = taxableBeforeDiscountCents - taxableDiscountCents;
  const nonTaxableCents = nonTaxableBeforeDiscountCents - (discountCents - taxableDiscountCents);
  const inclusiveCash = input.taxMode === "included" && input.tender === "cash";
  if (input.taxMode === "included" && !inclusiveCash) throw new Error("Tax-inclusive pricing is only valid for cash tender");
  const tenderTax = isTransactionTaxedTender(input.tender)
    ? inclusiveCash
      ? (() => {
          const rateBasis = BigInt(Math.round(input.taxRate * 1_000_000));
          const base = rateBasis > 0n ? roundRatio(BigInt(taxableCents) * 1_000_000n, 1_000_000n + rateBasis) : taxableCents;
          return { taxableBaseCents: base, taxCents: taxableCents - base };
        })()
      : computeTenderTaxCents({ taxableMerchandiseCents: taxableCents, taxRate: input.taxRate })
    : { taxableBaseCents: 0, taxCents: 0 };
  const taxCents = tenderTax.taxCents;
  const merchandiseTotalCents = inclusiveCash ? taxableCents + nonTaxableCents : taxableCents + nonTaxableCents + taxCents;
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const taxableSubtotal = moneyNumber(inclusiveCash ? tenderTax.taxableBaseCents : taxableCents);
  const nonTaxableSubtotal = moneyNumber(nonTaxableCents);
  const taxCollected = moneyNumber(taxCents);
  const cashDiscountAmount = moneyNumber(discountCents);
  return {
    taxableSubtotal, nonTaxableSubtotal, taxCollected,
    merchandiseTotal: moneyNumber(merchandiseTotalCents), cashDiscountAmount,
    taxSnapshot: { schemaVersion: 3, jurisdiction: input.taxJurisdiction ?? null, taxConfigurationId: input.taxConfigurationId ?? null, taxMode: input.taxMode, taxRate: input.taxRate, grossSubtotal: input.grossSubtotal, taxableSubtotal, nonTaxableSubtotal, customerTaxableTenderBase: moneyNumber(tenderTax.taxableBaseCents), customerTaxCollected: taxCollected, discounts: cashDiscountAmount, taxCalculated: taxCollected, taxCollected, roundingPolicy: "round_half_away_from_zero_per_order", tender: input.tender, exemptionReason: taxableCents === 0 ? "no_taxable_merchandise" : null, capturedAt },
    cashDiscountSnapshot: { schemaVersion: 1, enabled: input.cashDiscount.enabled, applied: discountCents > 0, type: input.cashDiscount.type, configuredValue, amount: cashDiscountAmount, tender: input.tender, capturedAt },
  };
}
