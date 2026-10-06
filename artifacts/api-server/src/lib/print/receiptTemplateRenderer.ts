/**
 * receiptTemplateRenderer.ts — template + ReceiptData → semantic receipt lines.
 *
 *   receipt template ─┐
 *                     ├─► renderReceiptFromTemplate ─► ReceiptLine[] ─► encoder
 *   ReceiptData ──────┘        (this file)             (semantic)      (receiptEncoders.ts)
 *
 * The layout is re-validated against the strict schema here, so unknown
 * fields/blocks are rejected. A template chooses, orders and styles fields;
 * every value comes from ReceiptData through the explicit formatter for that
 * field. No expressions, interpolation or printer bytes exist at this layer.
 */
import { receiptTemplateLayoutSchema, type ReceiptTemplateBlock } from "../printTemplateSchema";
import { formatMoney, sanitizeReceiptText, type ReceiptData } from "./receiptData";

export type ReceiptAlign = "left" | "center" | "right";
/** normal; tall = double height; large = double width and height. */
export type ReceiptTextSize = "normal" | "tall" | "large";
export type ReceiptRuleStyle = "solid" | "dashed" | "double";

export type ReceiptLine =
  | { readonly kind: "text"; readonly text: string; readonly align: ReceiptAlign; readonly bold: boolean; readonly size: ReceiptTextSize; readonly indent?: number }
  | { readonly kind: "columns"; readonly left: string; readonly right: string; readonly bold: boolean; readonly size: ReceiptTextSize }
  | { readonly kind: "rule"; readonly style: ReceiptRuleStyle }
  | { readonly kind: "feed"; readonly lines: number };

export interface SkippedBlock {
  readonly blockId: string;
  readonly field: string;
  readonly reason: "unsupported" | "no-data" | "condition";
}

export interface RenderedReceiptLines {
  readonly width: number;
  readonly lines: readonly ReceiptLine[];
  readonly skipped: readonly SkippedBlock[];
}

/** Fields the schema recognises that Phase 1 deliberately does not render. */
export const UNSUPPORTED_RECEIPT_FIELDS: ReadonlySet<string> = new Set(["logo", "qrCode"]);

export const MIN_RECEIPT_WIDTH = 24;
export const MAX_RECEIPT_WIDTH = 64;

/** Deterministic mapping of the schema's fontSize to printer text sizes. */
export function textSizeFor(fontSize: number): ReceiptTextSize {
  if (fontSize >= 32) return "large";
  if (fontSize >= 17) return "tall";
  return "normal";
}

/** Characters per line at a text size (double width halves the columns). */
export function columnsFor(width: number, size: ReceiptTextSize): number {
  return size === "large" ? Math.floor(width / 2) : width;
}

/** spacingBefore/After are in points; ~12pt per blank line, at most 4 lines. */
function feedLines(points: number): number {
  return Math.min(4, Math.round(points / 12));
}

export function wrapReceiptText(text: string, columns: number): string[] {
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (let word of words) {
    while (word.length > columns) {
      if (line) { lines.push(line); line = ""; }
      lines.push(word.slice(0, columns));
      word = word.slice(columns);
    }
    if (!word) continue;
    if (!line) line = word;
    else if (line.length + 1 + word.length <= columns) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

function formatDateTime(isoInstant: string, timeZone: string): string {
  const date = new Date(isoInstant);
  const options: Intl.DateTimeFormatOptions = {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date) + " UTC";
  }
}

type Style = { align: ReceiptAlign; bold: boolean; size: ReceiptTextSize };
type DataBlock = Extract<ReceiptTemplateBlock, { type: "data" }>;

type TextLine = Extract<ReceiptLine, { kind: "text" }>;
const text = (value: string, style: Style): TextLine => ({ kind: "text", text: value, ...style });
const columns = (left: string, right: string, style: Style): ReceiptLine => ({ kind: "columns", left, right, bold: style.bold, size: style.size });

function conditionHolds(when: DataBlock["when"], data: ReceiptData): boolean {
  switch (when) {
    case undefined: return true;
    case "hasLogo": return false;
    case "hasQrCode": return false;
    case "hasCustomerName": return Boolean(data.customer.safeName || data.customer.fullName);
    case "hasDiscount": return data.totals.discountCents > 0;
    case "hasTax": return data.totals.taxCents > 0;
    case "isCash": return data.payment.isCash;
    case "hasChange": return (data.payment.changeCents ?? 0) > 0;
  }
}

/** One explicit formatter per field. Returns [] when the data is absent. */
function formatField(block: DataBlock, data: ReceiptData, style: Style): ReceiptLine[] {
  const label = block.label !== undefined ? sanitizeReceiptText(block.label, 80) : undefined;
  const labelled = (fallback: string) => label ?? fallback;
  switch (block.field) {
    case "businessName":
      return [text(data.business.name, style)];
    case "businessAddress":
      return data.business.addressLines.map((line) => text(line, style));
    case "businessPhone":
      return data.business.phone ? [text(data.business.phone, style)] : [];
    case "orderNumber":
      return [text(`${labelled("Order")} #${data.order.number}`, style)];
    case "dateTime": {
      const when = formatDateTime(data.order.placedAt, data.order.timezone);
      return [text(label ? `${label} ${when}` : when, style)];
    }
    case "csr":
      return data.employeeName ? [text(`${labelled("Employee")}: ${data.employeeName}`, style)] : [];
    case "customerSafeName":
      return data.customer.safeName ? [text(`${labelled("Customer")}: ${data.customer.safeName}`, style)] : [];
    case "customerName":
      return data.customer.fullName ? [text(`${labelled("Customer")}: ${data.customer.fullName}`, style)] : [];
    case "items": {
      const lines: ReceiptLine[] = [];
      const detail = (value: string) => lines.push({ ...text(value, { ...style, align: "left" }), indent: 3 });
      for (const item of data.items) {
        lines.push(columns(`${item.quantity}  ${item.displayName}`, formatMoney(item.lineTotalCents), style));
        if (item.secondaryName) detail(item.secondaryName);
        if (item.optionLabel && block.showOption !== false) detail(item.optionLabel);
        if (item.sku && block.showSku === true) detail(`SKU ${item.sku}`);
        if (block.showUnitPrice === true) detail(`@ ${formatMoney(item.unitPriceCents)} ea`);
        if (item.note && block.showItemNotes !== false) detail(`* ${item.note}`);
      }
      return lines;
    }
    case "subtotal":
      return [columns(labelled("Subtotal"), formatMoney(data.totals.subtotalCents), style)];
    case "discounts":
      return data.totals.discountCents > 0
        ? [columns(labelled("Discount"), formatMoney(-data.totals.discountCents), style)]
        : [];
    case "salesTax": {
      const { taxCents, taxRatePercent, taxJurisdiction } = data.totals;
      if (taxCents === 0 && !taxRatePercent) return [];
      const name = label ?? ["Tax", taxRatePercent ? `${taxRatePercent}%` : "", taxJurisdiction ? `- ${taxJurisdiction}` : ""].filter(Boolean).join(" ");
      return [columns(name, formatMoney(taxCents), style)];
    }
    case "tenderType": {
      const { tenderLabel, tenderAmountCents, status } = data.payment;
      if (!tenderLabel) return [];
      const pending = status && !["paid", "captured"].includes(status) ? ` (${status})` : "";
      const name = `${labelled("Paid by")} ${tenderLabel}${pending}`;
      return [tenderAmountCents === null ? text(name, style) : columns(name, formatMoney(tenderAmountCents), style)];
    }
    case "paymentReference":
      return data.payment.referenceMasked ? [columns(labelled("Reference"), data.payment.referenceMasked, style)] : [];
    case "total":
      return [columns(labelled("TOTAL"), formatMoney(data.totals.totalCents), style)];
    case "cashReceived":
      return data.payment.isCash && data.payment.cashReceivedCents !== null
        ? [columns(labelled("Cash received"), formatMoney(data.payment.cashReceivedCents), style)]
        : [];
    case "change":
      return data.payment.isCash && data.payment.changeCents !== null
        ? [columns(labelled("Change"), formatMoney(data.payment.changeCents), style)]
        : [];
    case "thankYou":
      return [text(label ?? "Thank you!", style)];
    case "logo":
    case "qrCode":
      return [];
  }
}

/** Wraps text lines to the columns available at their size. */
function fitToWidth(line: ReceiptLine, width: number): ReceiptLine[] {
  if (line.kind === "text") {
    const indent = line.indent ?? 0;
    return wrapReceiptText(line.text, Math.max(1, columnsFor(width, line.size) - indent)).map((part) => ({ ...line, text: part }));
  }
  if (line.kind === "columns") {
    const available = columnsFor(width, line.size);
    const room = available - line.right.length - 1;
    if (line.left.length <= room) return [line];
    const wrapped = wrapReceiptText(line.left, Math.max(1, room));
    return [
      ...wrapped.slice(0, -1).map((part): ReceiptLine => ({ kind: "text", text: part, align: "left", bold: line.bold, size: line.size })),
      { ...line, left: wrapped.at(-1) ?? "" },
    ];
  }
  return [line];
}

/** Lays out already-built semantic lines for a roll width (used by non-template thermal documents). */
export function fitReceiptLines(lines: readonly ReceiptLine[], width: number): RenderedReceiptLines {
  const safeWidth = Math.min(MAX_RECEIPT_WIDTH, Math.max(MIN_RECEIPT_WIDTH, Math.trunc(width)));
  return { width: safeWidth, lines: lines.flatMap((line) => fitToWidth(line, safeWidth)), skipped: [] };
}

/**
 * Renders a receipt template against server-built ReceiptData.
 * Throws if the layout is not valid under the strict template schema.
 */
export function renderReceiptFromTemplate(layout: unknown, data: ReceiptData, width: number): RenderedReceiptLines {
  const blocks = receiptTemplateLayoutSchema.parse(layout);
  const safeWidth = Math.min(MAX_RECEIPT_WIDTH, Math.max(MIN_RECEIPT_WIDTH, Math.trunc(width)));
  const lines: ReceiptLine[] = [];
  const skipped: SkippedBlock[] = [];

  for (const block of blocks) {
    if (!block.enabled) continue;
    let content: ReceiptLine[];
    if (block.type === "separator") {
      content = [{ kind: "rule", style: block.style }];
    } else {
      const style: Style = { align: block.align, bold: block.bold, size: textSizeFor(block.fontSize) };
      const field = block.type === "data" ? block.field : "customText";
      if (UNSUPPORTED_RECEIPT_FIELDS.has(field)) {
        skipped.push({ blockId: block.id, field, reason: "unsupported" });
        continue;
      }
      if (!conditionHolds(block.when, data)) {
        skipped.push({ blockId: block.id, field, reason: "condition" });
        continue;
      }
      if (block.type === "customText") {
        const value = sanitizeReceiptText(block.text, 500);
        content = value ? [text(value, style)] : [];
      } else {
        content = formatField(block, data, style);
        if (!content.length) {
          skipped.push({ blockId: block.id, field: block.field, reason: "no-data" });
          continue;
        }
      }
    }
    const before = feedLines(block.spacingBefore);
    const after = feedLines(block.spacingAfter);
    if (before) lines.push({ kind: "feed", lines: before });
    for (const line of content) lines.push(...fitToWidth(line, safeWidth));
    if (after) lines.push({ kind: "feed", lines: after });
  }

  return { width: safeWidth, lines, skipped };
}
