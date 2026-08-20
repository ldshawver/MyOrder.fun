import type { PrintBlock } from "../renderer";
import { spacedText, formatReceiptDate } from "../formatter";

export interface ReceiptOrderItem {
  name: string;
  quantity: number | string;
  unitPrice: number | string;
  totalPrice?: number | string;
  notes?: string | null;
}

export interface CustomerReceiptData {
  orderId: number | string;
  orderNumber?: string | null;
  createdAt?: string | Date | null;
  customerName?: string | null;
  fulfillmentType?: string | null;
  operatorName?: string | null;
  paymentStatus?: string | null;
  paymentMethod?: string | null;
  notes?: string | null;
  items: ReceiptOrderItem[];
  subtotal: number | string;
  tax?: number | string | null;
  discount?: number | string | null;
  taxableSubtotal?: number | string | null;
  taxRate?: number | string | null;
  taxJurisdiction?: string | null;
  total: number | string;
  customerCreditApplied?: number | string | null;
  remainingPaymentMethod?: string | null;
  remainingPaymentAmount?: number | string | null;
  cashTendered?: number | string | null;
  changeGiven?: number | string | null;
  providerCaptureReference?: string | null;
  remainingCustomerCreditBalance?: number | string | null;
  adjustmentTotal?: number | string | null;
  // ── Branding ────────────────────────────────────────────────────────────────
  logoLines?: string[];       // pre-rendered logo (from getLogo); when absent, no logo block
  dualBrandName?: string | null; // second brand shown under logo (e.g. "LUCIFER CRUZ ADULT BOUTIQUE")
  footerMessage?: string | null;
  // ── Options ─────────────────────────────────────────────────────────────────
  showDiscreetNotice?: boolean;
  showOperatorName?: boolean;
  receiptTemplateStyle?: "clean" | "classic" | "compact";
  // ── Legacy (ignored — kept for backward compat) ──────────────────────────────
  brandName?: string | null;
}

export function buildCustomerReceiptBlocks(data: CustomerReceiptData): PrintBlock[] {
  const blocks: PrintBlock[] = [];

  // ═══════════════════════════════════════════════════════
  // HEADER — Logo + brand
  // ═══════════════════════════════════════════════════════

  const templateStyle = data.receiptTemplateStyle ?? "clean";
  blocks.push({ type: "divider", char: templateStyle === "compact" ? "-" : "=" });

  if (templateStyle !== "compact" && data.logoLines?.length) {
    blocks.push({ type: "spacer" });
    blocks.push({ type: "logo", lines: data.logoLines });
    if (data.dualBrandName?.trim()) {
      blocks.push({ type: "spacer" });
      blocks.push({ type: "center", text: `- ${data.dualBrandName.trim().toUpperCase()} -` });
    }
    blocks.push({ type: "spacer" });
  } else if (templateStyle === "compact" && data.dualBrandName?.trim()) {
    blocks.push({ type: "center", text: data.dualBrandName.trim().toUpperCase() });
  }

  blocks.push({ type: "divider", char: templateStyle === "compact" ? "-" : "=" });

  // ── Document title ───────────────────────────────────────────────────────────
  if (templateStyle !== "compact") blocks.push({ type: "spacer" });
  blocks.push({ type: "center", text: templateStyle === "classic" ? spacedText("CUSTOMER RECEIPT") : spacedText("RECEIPT") });
  if (templateStyle !== "compact") blocks.push({ type: "spacer" });

  // ═══════════════════════════════════════════════════════
  // ORDER INFO
  // ═══════════════════════════════════════════════════════

  blocks.push({ type: "divider", char: "-" });

  const orderRef = `  #${data.orderNumber ?? data.orderId}`;
  const dateStr  = formatReceiptDate(data.createdAt);
  blocks.push({ type: "kv", left: orderRef, right: dateStr });

  // Customer + fulfillment on one line when both present
  if (data.customerName && data.fulfillmentType) {
    blocks.push({ type: "kv", left: `  ${data.customerName}`, right: data.fulfillmentType });
  } else if (data.customerName) {
    blocks.push({ type: "text", text: `  ${data.customerName}` });
  } else if (data.fulfillmentType) {
    blocks.push({ type: "kv", left: "  Type", right: data.fulfillmentType });
  }

  // Payment status + method on one line
  if (data.paymentStatus || data.paymentMethod) {
    const statusStr = data.paymentStatus?.toUpperCase() ?? "";
    const methodStr = data.paymentMethod ?? "";
    const paymentLabel = [statusStr, methodStr].filter(Boolean).join(" · ");
    blocks.push({ type: "kv", left: "  Payment", right: paymentLabel });
  }

  // ── Order-level note ─────────────────────────────────────────────────────────
  if (data.notes?.trim()) {
    blocks.push({ type: "divider", char: "-" });
    blocks.push({ type: "text", text: "  Note:" });
    // Indent wrapped note text
    const noteWords = data.notes.trim().split(" ");
    let line = "    ";
    for (const word of noteWords) {
      if (line.length > 4 && line.length + word.length + 1 > 46) {
        blocks.push({ type: "text", text: line });
        line = "    " + word;
      } else {
        line += (line.length > 4 ? " " : "") + word;
      }
    }
    if (line.trim()) blocks.push({ type: "text", text: line });
  }

  // ═══════════════════════════════════════════════════════
  // LINE ITEMS
  // ═══════════════════════════════════════════════════════

  blocks.push({ type: "divider", char: "-" });
  blocks.push({ type: "colHeader" });
  blocks.push({ type: "divider", char: "-" });

  for (const item of data.items ?? []) {
    const qty   = Number(item.quantity ?? 1);
    const unit  = Number(item.unitPrice ?? 0);
    const total = Number(item.totalPrice ?? unit * qty);
    blocks.push({
      type: "receiptItem",
      name: item.name,
      qty,
      total,
      notes: item.notes ?? null,
    });
  }

  // ═══════════════════════════════════════════════════════
  // TOTALS
  // ═══════════════════════════════════════════════════════

  blocks.push({ type: "divider", char: "-" });
  blocks.push({ type: "totalLine", label: "Subtotal", amount: data.subtotal });

  const discount = Number(data.discount ?? 0);
  if (discount > 0) blocks.push({ type: "totalLine", label: "Discount", amount: -discount });

  if (data.taxableSubtotal !== undefined && data.taxableSubtotal !== null) {
    blocks.push({ type: "totalLine", label: "Taxable subtotal", amount: data.taxableSubtotal });
  }

  const taxAmt = Number(data.tax ?? 0);
  if (taxAmt > 0) {
    const rate = Number(data.taxRate ?? 0);
    const rateLabel = rate > 0 ? ` ${(rate * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%` : "";
    const jurisdiction = data.taxJurisdiction?.trim() ? ` · ${data.taxJurisdiction.trim()}` : "";
    blocks.push({ type: "totalLine", label: `Sales tax${rateLabel}${jurisdiction}`, amount: taxAmt });
  }

  blocks.push({ type: "divider", char: "=" });
  blocks.push({ type: "totalLine", label: "TOTAL", amount: data.total, strong: true });
  blocks.push({ type: "divider", char: "=" });

  const credit = Number(data.customerCreditApplied ?? 0);
  if (credit > 0) blocks.push({ type: "totalLine", label: "Customer Credit", amount: -credit });
  const remaining = Number(data.remainingPaymentAmount ?? 0);
  if (remaining > 0) blocks.push({ type: "totalLine", label: data.remainingPaymentMethod ?? "Remaining payment", amount: remaining });
  if (data.cashTendered !== undefined && data.cashTendered !== null) blocks.push({ type: "totalLine", label: "Cash tendered", amount: data.cashTendered });
  if (Number(data.changeGiven ?? 0) > 0) blocks.push({ type: "totalLine", label: "Change", amount: Number(data.changeGiven ?? 0) });
  if (data.providerCaptureReference?.trim()) {
    const safeRef = data.providerCaptureReference.trim().slice(-8);
    blocks.push({ type: "kv", left: "  Provider capture", right: `…${safeRef}` });
  }
  if (data.remainingCustomerCreditBalance !== undefined && data.remainingCustomerCreditBalance !== null) blocks.push({ type: "totalLine", label: "Customer Credit balance", amount: data.remainingCustomerCreditBalance });
  if (Number(data.adjustmentTotal ?? 0) !== 0) blocks.push({ type: "totalLine", label: "Refund/void adjustments", amount: Number(data.adjustmentTotal ?? 0) });

  // ═══════════════════════════════════════════════════════
  // FOOTER
  // ═══════════════════════════════════════════════════════

  blocks.push({ type: "spacer" });

  // Operator line (below totals, before thank-you)
  if (data.showOperatorName !== false && data.operatorName?.trim()) {
    blocks.push({ type: "kv", left: "  Operator", right: data.operatorName.trim() });
    blocks.push({ type: "spacer" });
  }

  // Thank-you message
  const footer = data.footerMessage?.trim() || "Thank you for your trust.";
  blocks.push({ type: "center", text: footer });

  // Discreet notice — elegant phrasing
  if (data.showDiscreetNotice) {
    blocks.push({ type: "spacer" });
    blocks.push({ type: "divider", char: "-" });
    blocks.push({ type: "center", text: "Your privacy is our commitment." });
    blocks.push({ type: "center", text: "All orders are handled discreetly." });
    blocks.push({ type: "center", text: "Please store this receipt securely." });
    blocks.push({ type: "divider", char: "-" });
  }

  blocks.push({ type: "spacer", count: 2 });
  return blocks;
}
