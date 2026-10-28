/**
 * Closeout money is calculated in integer cents.  Database numerics normally
 * arrive as strings, so accepting a value here is an explicit validation
 * boundary rather than a JavaScript coercion.
 */
const MAX_ABSOLUTE_CENTS = 1_000_000_000_000n; // $10 billion
const DECIMAL_MONEY = /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

export class ShiftCloseoutFinancialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShiftCloseoutFinancialError";
  }
}

function centsFromDecimal(value: string, field: string): bigint {
  const text = value.trim();
  if (!DECIMAL_MONEY.test(text)) throw new ShiftCloseoutFinancialError(`${field} must be a decimal monetary value`);
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  const cents = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  const signed = negative ? -cents : cents;
  if (signed > MAX_ABSOLUTE_CENTS || signed < -MAX_ABSOLUTE_CENTS) {
    throw new ShiftCloseoutFinancialError(`${field} is outside the supported closeout range`);
  }
  return signed;
}

/** Rejects malformed runtime values instead of treating them as zero. */
export function requiredMoneyCents(value: unknown, field: string): bigint {
  if (typeof value === "string") return centsFromDecimal(value, field);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ShiftCloseoutFinancialError(`${field} must be finite`);
    const cents = Math.round(value * 100);
    if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 1e-7) {
      throw new ShiftCloseoutFinancialError(`${field} must have no more than two decimal places`);
    }
    return centsFromDecimal((cents / 100).toFixed(2), field);
  }
  throw new ShiftCloseoutFinancialError(`${field} must be a number or decimal string`);
}

/** A missing aggregate means no matching rows; a present malformed value fails closed. */
export function aggregateMoneyCents(value: unknown, field: string): bigint {
  return value == null ? 0n : requiredMoneyCents(value, field);
}

function nonNegative(value: bigint, field: string): bigint {
  if (value < 0n) throw new ShiftCloseoutFinancialError(`${field} cannot be negative`);
  return value;
}

export function requiredNonNegativeMoneyCents(value: unknown, field: string): bigint {
  return nonNegative(requiredMoneyCents(value, field), field);
}

type ShiftPayoutOrder = {
  paymentStatus?: string | null;
  paymentMethod?: string | null;
  routeSource?: string | null;
  subtotal?: unknown;
  checkoutConversionSnapshot?: unknown;
};

/** Orders passed here are already tenant- and shift-scoped by the caller. */
export function sumCommissionableDiscountedProductSales(orders: readonly ShiftPayoutOrder[]): bigint {
  return orders.reduce((total, order) => {
    const method = String(order.paymentMethod ?? "").toLowerCase().replace(/[\s-]+/g, "_");
    if (order.paymentStatus !== "paid" || order.routeSource === "general_account" || method.split(/[+,]/).includes("comp")) return total;
    return total + requiredNonNegativeMoneyCents(order.subtotal, "commissionableProductSubtotal");
  }, 0n);
}

/** Customer tips are passed through at 100%; they are not commission sales. */
export function sumCustomerTipsForShift(orders: readonly ShiftPayoutOrder[]): bigint {
  return orders.reduce((total, order) => {
    if (order.paymentStatus !== "paid" || order.routeSource === "general_account") return total;
    const snapshot = order.checkoutConversionSnapshot && typeof order.checkoutConversionSnapshot === "object"
      ? order.checkoutConversionSnapshot as Record<string, unknown>
      : {};
    const tip = snapshot.tip && typeof snapshot.tip === "object" ? snapshot.tip as Record<string, unknown> : {};
    return total + (tip.amount == null ? 0n : requiredNonNegativeMoneyCents(tip.amount, "customerTip"));
  }, 0n);
}

/** The retained CSR share is exactly 80% of the server-recorded fee. */
export function calculateCsrDeliveryShareCents(deliveryFee: unknown): bigint {
  const feeCents = requiredNonNegativeMoneyCents(deliveryFee, "deliveryFee");
  return (feeCents * 80n + 50n) / 100n;
}

export function formatMoneyCents(cents: bigint): string {
  const negative = cents < 0n;
  const unsigned = negative ? -cents : cents;
  return `${negative ? "-" : ""}${unsigned / 100n}.${String(unsigned % 100n).padStart(2, "0")}`;
}

export function moneyNumber(cents: bigint): number {
  const parsed = Number(formatMoneyCents(cents));
  if (!Number.isFinite(parsed)) throw new ShiftCloseoutFinancialError("Calculated closeout money is not finite");
  return parsed;
}

export type CloseoutFinancialInput = {
  totalRevenue: unknown;
  cashSales: unknown;
  /** null/undefined is the valid no-matching-comp-rows case. */
  compSales: unknown;
  employeeDiscountSales: unknown;
  cashBankStart: unknown;
  cashBankEndReported: unknown;
  differenceAmount: unknown;
  tipPercent: unknown;
  /** Paid discounted merchandise only; excludes General Queue, fees, tax, and customer tips. */
  commissionSalesBase?: unknown;
  /** Customer tips owed to the CSR at closeout. */
  customerTips?: unknown;
  /** CSR delivery share already accrued for completed paid handoffs. */
  csrDeliveryEarnings?: unknown;
};

export type CloseoutFinancials = {
  totalRevenue: number;
  cashSales: number;
  compSales: number;
  employeeDiscountSales: number;
  qualifyingSales: number;
  eligibleSalesBase: number;
  commissionSalesBase: number;
  customerTips: number;
  csrDeliveryEarnings: number;
  totalCsrPayout: number;
  tipPercent: number;
  tipAmount: number;
  differenceAmount: number;
  finalTip: number;
  cashBankStart: number;
  cashBankEndReported: number;
  depositAmount: number;
  newCashBalance: number;
  persistence: {
    qualifyingSales: string;
    commissionBasis: string;
    commissionRate: string;
    adjustments: string;
    commissionAmount: string;
    tipAmount: string;
    differenceAmount: string;
    depositAmount: string;
  };
};

function tipPercentValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new ShiftCloseoutFinancialError("tipPercent must be a finite whole percentage");
  }
  return value;
}

/**
 * Calculates every persisted closeout monetary value from validated inputs.
 * There is intentionally no `Number(value) || 0` fallback here: only absent
 * aggregate rows are interpreted as zero.
 */
export function calculateCloseoutFinancials(input: CloseoutFinancialInput): CloseoutFinancials {
  const totalRevenue = nonNegative(requiredMoneyCents(input.totalRevenue, "totalRevenue"), "totalRevenue");
  const cashSales = nonNegative(requiredMoneyCents(input.cashSales, "cashSales"), "cashSales");
  const compSales = nonNegative(aggregateMoneyCents(input.compSales, "compSales"), "compSales");
  const employeeDiscountSales = nonNegative(requiredMoneyCents(input.employeeDiscountSales, "employeeDiscountSales"), "employeeDiscountSales");
  const cashBankStart = nonNegative(requiredMoneyCents(input.cashBankStart, "cashBankStart"), "cashBankStart");
  const cashBankEndReported = nonNegative(requiredMoneyCents(input.cashBankEndReported, "cashBankEndReported"), "cashBankEndReported");
  const differenceAmount = nonNegative(requiredMoneyCents(input.differenceAmount, "differenceAmount"), "differenceAmount");
  const tipPercent = tipPercentValue(input.tipPercent);
  const commissionSalesBase = input.commissionSalesBase == null
    ? totalRevenue - compSales
    : nonNegative(requiredMoneyCents(input.commissionSalesBase, "commissionSalesBase"), "commissionSalesBase");
  const customerTips = nonNegative(aggregateMoneyCents(input.customerTips, "customerTips"), "customerTips");
  const csrDeliveryEarnings = nonNegative(aggregateMoneyCents(input.csrDeliveryEarnings, "csrDeliveryEarnings"), "csrDeliveryEarnings");

  const qualifyingSales = commissionSalesBase;
  const eligibleSalesBase = input.commissionSalesBase == null
    ? qualifyingSales - employeeDiscountSales
    : commissionSalesBase;
  if (input.commissionSalesBase == null && qualifyingSales < 0n) throw new ShiftCloseoutFinancialError("compSales cannot exceed totalRevenue");
  if (eligibleSalesBase < 0n) throw new ShiftCloseoutFinancialError("employeeDiscountSales cannot exceed qualifying sales");
  // The legacy rule rounds the percentage result to the nearest cent.
  const tipAmount = (eligibleSalesBase * BigInt(tipPercent) + 50n) / 100n;
  const finalTip = tipAmount > differenceAmount ? tipAmount - differenceAmount : 0n;
  const totalCsrPayout = finalTip + customerTips + csrDeliveryEarnings;
  const depositBase = cashSales - totalCsrPayout - cashBankStart;
  const depositAmount = depositBase > 0n ? depositBase : 0n;
  const newCashBalance = totalCsrPayout;

  const financials = {
    totalRevenue: moneyNumber(totalRevenue), cashSales: moneyNumber(cashSales), compSales: moneyNumber(compSales),
    employeeDiscountSales: moneyNumber(employeeDiscountSales), qualifyingSales: moneyNumber(qualifyingSales),
    eligibleSalesBase: moneyNumber(eligibleSalesBase), commissionSalesBase: moneyNumber(commissionSalesBase),
    customerTips: moneyNumber(customerTips), csrDeliveryEarnings: moneyNumber(csrDeliveryEarnings),
    totalCsrPayout: moneyNumber(totalCsrPayout), tipPercent, tipAmount: moneyNumber(tipAmount),
    differenceAmount: moneyNumber(differenceAmount), finalTip: moneyNumber(finalTip), cashBankStart: moneyNumber(cashBankStart),
    cashBankEndReported: moneyNumber(cashBankEndReported), depositAmount: moneyNumber(depositAmount), newCashBalance: moneyNumber(newCashBalance),
    persistence: {
      qualifyingSales: formatMoneyCents(qualifyingSales), commissionBasis: formatMoneyCents(eligibleSalesBase),
      commissionRate: (tipPercent / 100).toFixed(6), adjustments: formatMoneyCents(-differenceAmount),
      commissionAmount: formatMoneyCents(finalTip), tipAmount: formatMoneyCents(tipAmount),
      differenceAmount: formatMoneyCents(differenceAmount), depositAmount: formatMoneyCents(depositAmount),
    },
  } satisfies CloseoutFinancials;
  assertFiniteCloseoutFinancials(financials);
  return financials;
}

/** Last line of defense before a closeout snapshot or financial row is persisted. */
export function assertFiniteCloseoutFinancials(financials: CloseoutFinancials): void {
  for (const [field, value] of Object.entries(financials)) {
    if (field === "persistence" || field === "tipPercent") continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ShiftCloseoutFinancialError(`${field} is not a finite closeout monetary value`);
    }
  }
  for (const [field, value] of Object.entries(financials.persistence)) {
    if (field === "commissionRate") {
      const rate = typeof value === "string" && /^(?:0|1)(?:\.\d{1,6})?$/.test(value) ? Number(value) : NaN;
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new ShiftCloseoutFinancialError("persistence.commissionRate is invalid");
      continue;
    }
    requiredMoneyCents(value, `persistence.${field}`);
  }
}
