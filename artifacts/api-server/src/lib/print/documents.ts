/**
 * documents.ts — renderers for every non-template printable document.
 *
 *   thermal:   clock in/out, deposit, expo, work  → ReceiptLine[] (encoded by receiptEncoders)
 *   full page: stock lists, shift reports         → ReportDocument (rendered by pdfReport)
 *
 * Every builder takes data the server loaded itself; nothing here reads the
 * request. Order receipts keep using the receipt template pipeline.
 */
import { formatMoney, SAMPLE_RECEIPT_DATA, sanitizeReceiptText, type ReceiptData } from "./receiptData";
import type { ReceiptLine } from "./receiptTemplateRenderer";
import { formatReportDate, type ReportDocument, type ReportSection } from "./pdfReport";
import type { PrintDocumentType } from "./documentTypes";

// ── Shared helpers ────────────────────────────────────────────────────────────

const clean = (value: unknown, max = 80) => sanitizeReceiptText(value, max);
const center = (text: string, bold = false, size: "normal" | "tall" | "large" = "normal"): ReceiptLine =>
  ({ kind: "text", text: clean(text, 120), align: "center", bold, size });
const left = (text: string, bold = false): ReceiptLine => ({ kind: "text", text: clean(text, 200), align: "left", bold, size: "normal" });
const pair = (label: string, value: string, bold = false): ReceiptLine =>
  ({ kind: "columns", left: clean(label, 60), right: clean(value, 40), bold, size: "normal" });
const rule = (style: "solid" | "dashed" | "double" = "solid"): ReceiptLine => ({ kind: "rule", style });
const feed = (lines = 1): ReceiptLine => ({ kind: "feed", lines });

export function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return String(Math.round(value * 1000) / 1000);
}

/** "Casey Jones" → "Casey J." (employees and customers on paper). */
export function displayPersonName(first: string | null | undefined, last: string | null | undefined): string {
  const firstName = clean(first, 40);
  const initial = clean(last, 40).charAt(0).toUpperCase();
  return firstName ? (initial ? `${firstName} ${initial}.` : firstName) : "Staff";
}

const when = (iso: string, timezone: string) => formatReportDate(iso, timezone);

// ── Thermal documents ─────────────────────────────────────────────────────────

export interface ClockSlipData {
  readonly event: "in" | "out";
  readonly businessName: string;
  readonly locationName: string | null;
  readonly employeeName: string;
  /** ISO instant of the clock event, from the shift record. */
  readonly at: string;
  readonly timezone: string;
  readonly shiftRef: string;
}

export function buildClockSlip(data: ClockSlipData): ReceiptLine[] {
  return [
    center(data.businessName, true),
    rule("double"),
    center(data.event === "in" ? "CLOCK IN" : "CLOCK OUT", true, "tall"),
    rule("double"),
    pair("Employee", data.employeeName),
    ...(data.locationName ? [pair("Location", data.locationName)] : []),
    pair("Time", when(data.at, data.timezone)),
    pair("Shift", `#${data.shiftRef}`),
    rule("dashed"),
    feed(2),
  ];
}

export interface DepositSlipData {
  readonly businessName: string;
  readonly locationName: string | null;
  readonly employeeName: string;
  readonly shiftRef: string;
  readonly timezone: string;
  readonly clockedInAt: string;
  readonly clockedOutAt: string;
  readonly cashBankStartCents: number;
  readonly cashSalesCents: number;
  /** Server-computed cash that should be in the bank. */
  readonly expectedCashCents: number;
  /** Cash the employee counted at close-out (their reported count). */
  readonly countedCashCents: number | null;
  readonly varianceCents: number | null;
  readonly paymentTotals: ReadonlyArray<{ readonly label: string; readonly cents: number }>;
}

export function buildDepositSlip(data: DepositSlipData): ReceiptLine[] {
  return [
    center(data.businessName, true),
    rule("double"),
    center("DEPOSIT", true, "tall"),
    rule("double"),
    pair("Employee", data.employeeName),
    ...(data.locationName ? [pair("Location", data.locationName)] : []),
    pair("Shift", `#${data.shiftRef}`),
    pair("In", when(data.clockedInAt, data.timezone)),
    pair("Out", when(data.clockedOutAt, data.timezone)),
    rule(),
    pair("Starting cash bank", formatMoney(data.cashBankStartCents)),
    pair("Cash sales", formatMoney(data.cashSalesCents)),
    pair("Expected cash", formatMoney(data.expectedCashCents), true),
    pair("Counted cash (reported)", data.countedCashCents === null ? "not entered" : formatMoney(data.countedCashCents)),
    pair("Variance", data.varianceCents === null ? "-" : formatMoney(data.varianceCents), true),
    ...(data.paymentTotals.length ? [rule("dashed"), left("Sales by payment", true), ...data.paymentTotals.map((total) => pair(total.label, formatMoney(total.cents)))] : []),
    rule(),
    left("Counted by: ____________________"),
    feed(1),
    left("Verified by: ___________________"),
    feed(2),
  ];
}

function orderHeader(data: ReceiptData, title: string): ReceiptLine[] {
  return [
    center(title, true),
    center(`#${data.order.number}`, true, "large"),
    ...(data.order.fulfillment ? [center(data.order.fulfillment.toUpperCase(), true, "tall")] : []),
    center(when(data.order.placedAt, data.order.timezone)),
    ...(data.customer.safeName ? [center(data.customer.safeName)] : []),
    rule("double"),
  ];
}

/** Expo: fast to read at the pass. Order number, fulfilment, items, notes. No prices. */
export function buildExpoTicket(data: ReceiptData): ReceiptLine[] {
  const lines = orderHeader(data, "EXPO");
  for (const item of data.items) {
    lines.push({ kind: "text", text: `${item.quantity} x ${item.displayName}`, align: "left", bold: true, size: "tall" });
    if (item.optionLabel) lines.push({ kind: "text", text: item.optionLabel, align: "left", bold: false, size: "normal", indent: 4 });
    if (item.sku) lines.push({ kind: "text", text: `SKU: ${item.sku}`, align: "left", bold: false, size: "normal", indent: 4 });
    if (item.note) lines.push({ kind: "text", text: `* ${item.note}`, align: "left", bold: false, size: "normal", indent: 4 });
  }
  if (data.order.note) lines.push(rule("dashed"), left(`NOTE: ${data.order.note}`, true));
  lines.push(rule("double"), feed(2));
  return lines;
}

/** Work: preparation list with a check box per unit line. No prices, no customer. */
export function buildWorkTicket(data: ReceiptData): ReceiptLine[] {
  const lines: ReceiptLine[] = [
    center("WORK TICKET", true),
    center(`#${data.order.number}`, true, "large"),
    ...(data.order.fulfillment ? [center(data.order.fulfillment.toUpperCase(), true)] : []),
    center(when(data.order.placedAt, data.order.timezone)),
    rule("double"),
  ];
  for (const item of data.items) {
    lines.push({ kind: "text", text: `[ ] ${item.quantity} x ${item.displayName}`, align: "left", bold: true, size: "normal" });
    if (item.optionLabel) lines.push({ kind: "text", text: item.optionLabel, align: "left", bold: false, size: "normal", indent: 6 });
    if (item.sku) lines.push({ kind: "text", text: `SKU ${item.sku}`, align: "left", bold: false, size: "normal", indent: 6 });
    if (item.note) lines.push({ kind: "text", text: `* ${item.note}`, align: "left", bold: false, size: "normal", indent: 6 });
  }
  if (data.order.note) lines.push(rule("dashed"), left(`NOTE: ${data.order.note}`, true));
  lines.push(rule(), left("Prepared by: ____________________"), feed(2));
  return lines;
}

// ── Full-page documents ───────────────────────────────────────────────────────

export interface ShiftReportContext {
  readonly businessName: string;
  readonly locationName: string | null;
  readonly employeeName: string;
  readonly shiftRef: string;
  readonly timezone: string;
  readonly clockedInAt: string;
  readonly clockedOutAt: string | null;
  readonly generatedAt: string;
}

const shiftRange = (ctx: ShiftReportContext) =>
  `Shift #${ctx.shiftRef} - ${ctx.employeeName} - ${when(ctx.clockedInAt, ctx.timezone)}${ctx.clockedOutAt ? ` to ${when(ctx.clockedOutAt, ctx.timezone)}` : " (open)"}`;

export interface ShiftInventoryRow {
  readonly section: string | null;
  readonly name: string;
  readonly unit: string | null;
  readonly start: number | null;
  readonly sold: number | null;
  readonly counted: number | null;
  readonly par: number | null;
  readonly flagged: boolean;
}

export type ShiftInventoryKind = "beginning" | "ending" | "restock";

export function restockQuantity(row: ShiftInventoryRow): number {
  if (!row.par || row.par <= 0 || row.counted === null) return 0;
  return Math.max(0, row.par - row.counted);
}

export function buildShiftInventoryReport(ctx: ShiftReportContext, kind: ShiftInventoryKind, rows: readonly ShiftInventoryRow[]): ReportDocument {
  const base = {
    businessName: ctx.businessName, locationName: ctx.locationName, generatedAt: ctx.generatedAt,
    timezone: ctx.timezone, generatedBy: ctx.employeeName, rangeLabel: shiftRange(ctx),
  };
  const nameCols = [
    { key: "name", label: "Item", weight: 4 },
    { key: "section", label: "Section", weight: 2 },
    { key: "unit", label: "Unit", weight: 1 },
  ];
  if (kind === "beginning") {
    const section: ReportSection = {
      columns: [...nameCols, { key: "start", label: "Starting qty", align: "right" }, { key: "par", label: "PAR", align: "right" }],
      rows: rows.map((row) => ({ name: row.name, section: row.section ?? "", unit: row.unit ?? "", start: formatQuantity(row.start), par: formatQuantity(row.par) })),
      emptyText: "No inventory rows recorded for this shift",
    };
    return { ...base, title: "Beginning Inventory", summary: [{ label: "Items", value: String(rows.length) }], sections: [section] };
  }
  if (kind === "ending") {
    const flagged = rows.filter((row) => row.flagged).length;
    const section: ReportSection = {
      columns: [
        ...nameCols,
        { key: "start", label: "Start", align: "right" }, { key: "sold", label: "Sold", align: "right" },
        { key: "expected", label: "Expected", align: "right" }, { key: "counted", label: "Counted", align: "right" },
        { key: "difference", label: "Difference", align: "right" },
      ],
      rows: rows.map((row) => {
        const expected = row.start !== null ? row.start - (row.sold ?? 0) : null;
        const difference = expected !== null && row.counted !== null ? row.counted - expected : null;
        return {
          name: row.flagged ? `! ${row.name}` : row.name, section: row.section ?? "", unit: row.unit ?? "",
          start: formatQuantity(row.start), sold: formatQuantity(row.sold), expected: formatQuantity(expected),
          counted: formatQuantity(row.counted), difference: formatQuantity(difference),
        };
      }),
      emptyText: "No inventory rows recorded for this shift",
    };
    return {
      ...base, title: "Ending Inventory",
      summary: [{ label: "Items", value: String(rows.length) }, { label: "Flagged", value: String(flagged) }],
      sections: [section], footerNote: flagged ? "! = item flagged for review at close-out" : null,
    };
  }
  const needed = rows.filter((row) => restockQuantity(row) > 0);
  const section: ReportSection = {
    columns: [...nameCols, { key: "par", label: "PAR", align: "right" }, { key: "counted", label: "Counted end", align: "right" }, { key: "restock", label: "Restock", align: "right" }],
    rows: needed.map((row) => ({
      name: row.name, section: row.section ?? "", unit: row.unit ?? "",
      par: formatQuantity(row.par), counted: formatQuantity(row.counted), restock: `+${formatQuantity(restockQuantity(row))}`,
    })),
    emptyText: "Nothing needs restocking",
  };
  return { ...base, title: "Restock List", summary: [{ label: "Items to restock", value: String(needed.length) }], sections: [section] };
}

export interface ShiftSalesData {
  readonly orderCount: number;
  readonly totalRevenueCents: number;
  readonly paymentTotals: ReadonlyArray<{ readonly label: string; readonly cents: number }>;
  readonly items: ReadonlyArray<{ readonly name: string; readonly quantity: number; readonly revenueCents: number }>;
  readonly commissionCents: number | null;
}

export function buildShiftSalesReport(ctx: ShiftReportContext, sales: ShiftSalesData): ReportDocument {
  return {
    title: "Shift Sales Report",
    businessName: ctx.businessName, locationName: ctx.locationName, generatedAt: ctx.generatedAt,
    timezone: ctx.timezone, generatedBy: ctx.employeeName, rangeLabel: shiftRange(ctx),
    summary: [
      { label: "Orders", value: String(sales.orderCount) },
      { label: "Revenue", value: formatMoney(sales.totalRevenueCents) },
      ...(sales.commissionCents !== null ? [{ label: "Commission", value: formatMoney(sales.commissionCents) }] : []),
    ],
    sections: [
      {
        heading: "Sales by payment method",
        columns: [{ key: "method", label: "Payment method", weight: 3 }, { key: "amount", label: "Amount", align: "right" }],
        rows: sales.paymentTotals.filter((total) => total.cents !== 0).map((total) => ({ method: total.label, amount: formatMoney(total.cents) })),
        totals: { method: "Total", amount: formatMoney(sales.totalRevenueCents) },
        emptyText: "No sales",
      },
      {
        heading: "Items sold",
        columns: [{ key: "name", label: "Item", weight: 5 }, { key: "quantity", label: "Qty", align: "right" }, { key: "revenue", label: "Revenue", align: "right", weight: 1.5 }],
        rows: sales.items.map((item) => ({ name: item.name, quantity: formatQuantity(item.quantity), revenue: formatMoney(item.revenueCents) })),
        emptyText: "No items sold",
      },
    ],
  };
}

export interface StockListRow {
  readonly name: string;
  readonly sku: string | null;
  readonly option: string | null;
  readonly unit: string | null;
  readonly quantity: number | null;
  readonly par: number | null;
}

export interface StockListData {
  readonly businessName: string;
  readonly locationName: string;
  readonly generatedAt: string;
  readonly timezone: string;
  readonly generatedBy: string | null;
  readonly rows: readonly StockListRow[];
}

/** Current stock at a location; reorder = PAR minus on-hand when below PAR. */
export function buildStockList(data: StockListData): ReportDocument {
  const reorder = (row: StockListRow) => (row.par && row.quantity !== null && row.quantity < row.par ? row.par - row.quantity : 0);
  const below = data.rows.filter((row) => reorder(row) > 0).length;
  return {
    title: "Inventory Stock List",
    businessName: data.businessName, locationName: data.locationName, generatedAt: data.generatedAt,
    timezone: data.timezone, generatedBy: data.generatedBy,
    summary: [{ label: "Items", value: String(data.rows.length) }, { label: "Below PAR", value: String(below) }],
    sections: [{
      columns: [
        { key: "name", label: "Item", weight: 4 }, { key: "option", label: "Option", weight: 2 }, { key: "sku", label: "SKU", weight: 2 },
        { key: "unit", label: "Unit", weight: 1 }, { key: "quantity", label: "On hand", align: "right" },
        { key: "par", label: "PAR", align: "right" }, { key: "reorder", label: "Reorder", align: "right" },
      ],
      rows: data.rows.map((row) => ({
        name: row.name, option: row.option ?? "", sku: row.sku ?? "", unit: row.unit ?? "",
        quantity: formatQuantity(row.quantity), par: formatQuantity(row.par),
        reorder: reorder(row) > 0 ? `+${formatQuantity(reorder(row))}` : "",
      })),
      emptyText: "No stock recorded at this location",
    }],
  };
}

// ── Fixed synthetic samples (previews and test prints) ────────────────────────

const SAMPLE_AT = "2026-01-15T18:30:00.000Z";
const SAMPLE_CTX: ShiftReportContext = {
  businessName: "SAMPLE BUSINESS", locationName: "Sample Location", employeeName: "Sample E.", shiftRef: "SAMPLE",
  timezone: "America/Los_Angeles", clockedInAt: "2026-01-15T16:00:00.000Z", clockedOutAt: SAMPLE_AT, generatedAt: SAMPLE_AT,
};
const SAMPLE_ROWS: ShiftInventoryRow[] = [
  { section: "Sample Section", name: "Sample Item A", unit: "#", start: 10, sold: 3, counted: 7, par: 12, flagged: false },
  { section: "Sample Section", name: "Sample Item B", unit: "g", start: 25.5, sold: 5, counted: 19, par: 20, flagged: true },
];

export type SampleDocument = { kind: "thermal"; lines: ReceiptLine[] } | { kind: "report"; report: ReportDocument };

/** Synthetic sample for each document type. ORDER_RECEIPT uses the receipt pipeline instead. */
export function sampleDocument(type: Exclude<PrintDocumentType, "ORDER_RECEIPT">): SampleDocument {
  switch (type) {
    case "CLOCK_IN":
    case "CLOCK_OUT":
      return { kind: "thermal", lines: buildClockSlip({ event: type === "CLOCK_IN" ? "in" : "out", businessName: "SAMPLE BUSINESS", locationName: "Sample Location", employeeName: "Sample E.", at: SAMPLE_AT, timezone: "America/Los_Angeles", shiftRef: "SAMPLE" }) };
    case "DEPOSIT":
      return { kind: "thermal", lines: buildDepositSlip({ businessName: "SAMPLE BUSINESS", locationName: "Sample Location", employeeName: "Sample E.", shiftRef: "SAMPLE", timezone: "America/Los_Angeles", clockedInAt: SAMPLE_CTX.clockedInAt, clockedOutAt: SAMPLE_AT, cashBankStartCents: 10000, cashSalesCents: 4500, expectedCashCents: 14500, countedCashCents: 14450, varianceCents: -50, paymentTotals: [{ label: "Cash", cents: 4500 }, { label: "Card", cents: 3200 }] }) };
    case "EXPO":
      return { kind: "thermal", lines: buildExpoTicket(SAMPLE_RECEIPT_DATA) };
    case "WORK":
      return { kind: "thermal", lines: buildWorkTicket(SAMPLE_RECEIPT_DATA) };
    case "INVENTORY_STOCK_LIST":
      return { kind: "report", report: buildStockList({ businessName: "SAMPLE BUSINESS", locationName: "Sample Location", generatedAt: SAMPLE_AT, timezone: "America/Los_Angeles", generatedBy: "Sample E.", rows: [
        { name: "Sample Item A", sku: "SAMPLE-A", option: null, unit: "#", quantity: 7, par: 12 },
        { name: "Sample Item B", sku: "SAMPLE-B", option: "Sample Option", unit: "g", quantity: 19, par: 20 },
      ] }) };
    case "REPORT":
      return { kind: "report", report: buildShiftSalesReport(SAMPLE_CTX, { orderCount: 3, totalRevenueCents: 7700, paymentTotals: [{ label: "Cash", cents: 4500 }, { label: "Card", cents: 3200 }], items: [{ name: "Sample Item A", quantity: 3, revenueCents: 4500 }, { name: "Sample Item B", quantity: 5, revenueCents: 3200 }], commissionCents: null }) };
  }
}

export const SAMPLE_SHIFT_CONTEXT = SAMPLE_CTX;
export const SAMPLE_SHIFT_INVENTORY = SAMPLE_ROWS;
