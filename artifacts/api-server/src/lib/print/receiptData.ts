/**
 * receiptData.ts — the server-owned receipt data contract.
 *
 * Every receipt (automatic, reprint, preview) renders from one ReceiptData
 * value built here. It is:
 *   - authoritative: money comes from the order's own financial snapshot
 *     (never recomputed from the current catalogue);
 *   - minimal: no payment tokens, provider credentials, internal IDs or
 *     contact PII beyond display names;
 *   - clean: every string is stripped of printer control characters;
 *   - immutable: deep-frozen so no template or renderer can alter it.
 */

export type ReceiptLineNameMode = "alavont_only" | "lucifer_only" | "both";

export interface ReceiptItem {
  /** Name shown for the purchased product, as snapshotted on the order line. */
  readonly displayName: string;
  /** Second name for dual-brand ("both") mode; null otherwise. */
  readonly secondaryName: string | null;
  /** Selected option/variant label; null until orders snapshot options. */
  readonly optionLabel: string | null;
  /** Merchant SKU when snapshotted on the order line; null otherwise. */
  readonly sku: string | null;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
  readonly note: string | null;
}

export interface ReceiptData {
  readonly source: "order" | "sample";
  readonly business: {
    readonly name: string;
    readonly addressLines: readonly string[];
    readonly phone: string | null;
  };
  readonly order: {
    readonly number: string;
    /** ISO-8601 instant the order was placed. */
    readonly placedAt: string;
    readonly timezone: string;
    readonly fulfillment: string | null;
    readonly note: string | null;
  };
  readonly employeeName: string | null;
  readonly customer: {
    /** First name plus last initial. */
    readonly safeName: string | null;
    readonly fullName: string | null;
  };
  readonly items: readonly ReceiptItem[];
  readonly totals: {
    readonly subtotalCents: number;
    readonly discountCents: number;
    readonly taxableSubtotalCents: number | null;
    readonly taxCents: number;
    /** Percentage for display, e.g. "8.75"; null when unknown. */
    readonly taxRatePercent: string | null;
    readonly taxJurisdiction: string | null;
    readonly customerCreditCents: number;
    readonly totalCents: number;
  };
  readonly payment: {
    readonly status: string | null;
    readonly tenderLabel: string | null;
    readonly tenderAmountCents: number | null;
    readonly isCash: boolean;
    readonly cashReceivedCents: number | null;
    readonly changeCents: number | null;
    /** Last four characters of the provider capture id, e.g. "…A1B2". */
    readonly referenceMasked: string | null;
  };
}

// ── Sanitising and money ──────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\p{Cf}]/gu;

/** Removes control/format characters only, preserving layout spacing. */
export function stripControlCharacters(value: string): string {
  return value.replace(UNSAFE_TEXT, "");
}

/** Plain printable text: control/format characters become spaces, runs collapse. */
export function sanitizeReceiptText(value: unknown, maxLength = 200): string {
  if (value === null || value === undefined) return "";
  return String(value).normalize("NFC").replace(UNSAFE_TEXT, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

const optionalText = (value: unknown, maxLength = 200): string | null => sanitizeReceiptText(value, maxLength) || null;

/** Decimal string or number (e.g. "16.31") to integer cents, without float drift. */
export function toCents(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const text = String(value).trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,}))?$/.exec(text);
  if (!match) {
    const numeric = Number(text);
    return Number.isFinite(numeric) ? Math.round(numeric * 100) : 0;
  }
  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2)) + (Number(fraction[2] ?? 0) >= 5 ? 1 : 0);
  return sign ? -cents : cents;
}

const optionalCents = (value: unknown): number | null =>
  value === null || value === undefined || value === "" ? null : toCents(value);

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

// ── Building from order snapshots ─────────────────────────────────────────────

const TENDER_LABELS: Record<string, string> = {
  cash: "Cash",
  cash_app: "Cash App",
  paypal: "PayPal",
  paypal_card: "PayPal",
  card: "Card",
  manual: "Manual",
  customer_credit: "Customer Credit",
};

export function tenderLabel(method: string | null | undefined): string | null {
  if (!method) return null;
  return TENDER_LABELS[method] ?? sanitizeReceiptText(method.replace(/_/g, " "), 40);
}

export function maskReference(reference: string | null | undefined): string | null {
  const clean = sanitizeReceiptText(reference, 200).replace(/[^A-Za-z0-9]/g, "");
  return clean.length >= 4 ? `…${clean.slice(-4)}` : null;
}

function safeCustomerName(first: string | null | undefined, last: string | null | undefined): string | null {
  const firstName = sanitizeReceiptText(first, 40);
  const initial = sanitizeReceiptText(last, 40).charAt(0);
  if (!firstName) return null;
  return initial ? `${firstName} ${initial.toUpperCase()}.` : firstName;
}

function formatTaxRate(rate: unknown): string | null {
  const numeric = Number(rate);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return (numeric * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/** Snapshot rows the loader reads; all money is the stored order snapshot. */
export interface ReceiptSnapshotInput {
  business: { name: string | null; address: Record<string, unknown> | null; phone: string | null; timezone: string | null };
  order: {
    id: number;
    createdAt: Date | string;
    orderType?: string | null;
    notes?: string | null;
    paymentStatus?: string | null;
    paymentMethod?: string | null;
    subtotal?: unknown;
    grossSubtotal?: unknown;
    discountTotal?: unknown;
    taxableSubtotal?: unknown;
    tax?: unknown;
    total?: unknown;
    customerCreditApplied?: unknown;
    remainingTenderAmount?: unknown;
    amountTendered?: unknown;
    changeGiven?: unknown;
    taxSnapshot?: unknown;
  };
  items: ReadonlyArray<{
    catalogItemName: string;
    receiptName?: string | null;
    alavontName?: string | null;
    luciferCruzName?: string | null;
    optionLabel?: string | null;
    sku?: string | null;
    quantity: number;
    unitPrice: unknown;
    totalPrice: unknown;
    note?: string | null;
  }>;
  lineNameMode: ReceiptLineNameMode;
  customer: { firstName?: string | null; lastName?: string | null } | null;
  employee: { firstName?: string | null; lastName?: string | null } | null;
  providerCaptureId?: string | null;
}

function itemNames(item: ReceiptSnapshotInput["items"][number], mode: ReceiptLineNameMode): { displayName: string; secondaryName: string | null } {
  const catalog = item.catalogItemName;
  const customerSafe = item.receiptName ?? item.luciferCruzName ?? catalog;
  if (mode === "alavont_only") return { displayName: item.alavontName ?? catalog, secondaryName: null };
  if (mode === "lucifer_only") return { displayName: customerSafe, secondaryName: null };
  const primary = item.alavontName ?? catalog;
  return { displayName: primary, secondaryName: customerSafe !== primary ? customerSafe : null };
}

export function buildReceiptData(input: ReceiptSnapshotInput): ReceiptData {
  const { order } = input;
  const taxSnapshot = (order.taxSnapshot && typeof order.taxSnapshot === "object" ? order.taxSnapshot : {}) as Record<string, unknown>;
  const address = input.business.address ?? {};
  const cityLine = [address.city, address.region].map((part) => sanitizeReceiptText(part, 60)).filter(Boolean).join(", ");
  const addressLines = [
    sanitizeReceiptText(address.line1, 80),
    sanitizeReceiptText(address.line2, 80),
    [cityLine, sanitizeReceiptText(address.postalCode, 20)].filter(Boolean).join(" "),
  ].filter(Boolean);
  const isCash = order.paymentMethod === "cash";
  const employee = input.employee ? sanitizeReceiptText(input.employee.firstName, 40) || null : null;

  const data: ReceiptData = {
    source: "order",
    business: {
      name: sanitizeReceiptText(input.business.name, 80) || "MyOrder.fun",
      addressLines,
      phone: optionalText(input.business.phone, 40),
    },
    order: {
      number: String(order.id),
      placedAt: new Date(order.createdAt).toISOString(),
      timezone: sanitizeReceiptText(input.business.timezone, 64) || "America/Los_Angeles",
      fulfillment: optionalText(order.orderType, 40),
      note: optionalText(order.notes, 300),
    },
    employeeName: employee,
    customer: {
      safeName: input.customer ? safeCustomerName(input.customer.firstName, input.customer.lastName) : null,
      fullName: input.customer
        ? optionalText([input.customer.firstName, input.customer.lastName].filter(Boolean).join(" "), 80)
        : null,
    },
    items: input.items.map((item) => {
      const names = itemNames(item, input.lineNameMode);
      return {
        displayName: sanitizeReceiptText(names.displayName, 120) || "Item",
        secondaryName: optionalText(names.secondaryName, 120),
        optionLabel: optionalText(item.optionLabel, 80),
        sku: optionalText(item.sku, 64),
        quantity: Math.max(0, Math.trunc(Number(item.quantity) || 0)),
        unitPriceCents: toCents(item.unitPrice),
        lineTotalCents: toCents(item.totalPrice),
        note: optionalText(item.note, 160),
      };
    }),
    totals: {
      subtotalCents: toCents(order.grossSubtotal ?? order.subtotal),
      discountCents: Math.abs(toCents(order.discountTotal)),
      taxableSubtotalCents: optionalCents(order.taxableSubtotal),
      taxCents: toCents(order.tax),
      taxRatePercent: formatTaxRate(taxSnapshot.taxRate),
      taxJurisdiction: optionalText(taxSnapshot.jurisdiction, 60),
      customerCreditCents: Math.abs(toCents(order.customerCreditApplied)),
      totalCents: toCents(order.total),
    },
    payment: {
      status: optionalText(order.paymentStatus, 30),
      tenderLabel: tenderLabel(order.paymentMethod),
      tenderAmountCents: optionalCents(order.remainingTenderAmount),
      isCash,
      cashReceivedCents: isCash ? optionalCents(order.amountTendered) : null,
      changeCents: isCash ? optionalCents(order.changeGiven) : null,
      referenceMasked: isCash ? null : maskReference(input.providerCaptureId),
    },
  };
  return deepFreeze(data);
}

/** Fixed synthetic data for previews. No real customer, order or payment. */
export const SAMPLE_RECEIPT_DATA: ReceiptData = deepFreeze({
  source: "sample",
  business: { name: "SAMPLE BUSINESS", addressLines: ["123 Sample Street", "Sampletown, CA 90000"], phone: "(555) 010-0000" },
  order: { number: "SAMPLE-0001", placedAt: "2026-01-15T18:30:00.000Z", timezone: "America/Los_Angeles", fulfillment: "Pickup", note: null },
  employeeName: "Sample Employee",
  customer: { safeName: "Sample C.", fullName: "Sample Customer" },
  items: [
    { displayName: "Sample Product", secondaryName: null, optionLabel: "Sample Option", sku: "SAMPLE-SKU-1", quantity: 2, unitPriceCents: 1000, lineTotalCents: 2000, note: null },
    { displayName: "Another Sample Product", secondaryName: null, optionLabel: null, sku: null, quantity: 1, unitPriceCents: 1200, lineTotalCents: 1200, note: "Sample note" },
  ],
  totals: { subtotalCents: 3200, discountCents: 200, taxableSubtotalCents: 3000, taxCents: 263, taxRatePercent: "8.75", taxJurisdiction: "Sample County", customerCreditCents: 0, totalCents: 3263 },
  payment: { status: "paid", tenderLabel: "Cash", tenderAmountCents: 3263, isCash: true, cashReceivedCents: 4000, changeCents: 737, referenceMasked: null },
} satisfies ReceiptData);
