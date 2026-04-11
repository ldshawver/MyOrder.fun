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
  total: number | string;
  // ── Branding ────────────────────────────────────────────────────────────────
  logoLines?: string[];       // pre-rendered logo (from getLogo); when absent, no logo block
  dualBrandName?: string | null; // second brand shown under logo (e.g. "LUCIFER CRUZ ADULT BOUTIQUE")
  footerMessage?: string | null;
  // ── Options ─────────────────────────────────────────────────────────────────
  showDiscreetNotice?: boolean;
  showOperatorName?: boolean;
  // ── Legacy (ignored — kept for backward compat) ──────────────────────────────
  brandName?: string | null;
}

export function buildCustomerReceiptBlocks(data: CustomerReceiptData): PrintBlock[] {
  const blocks: PrintBlock[] = [];

  // ═══════════════════════════════════════════════════════
  // HEADER — Logo + brand
  // ═══════════════════════════════════════════════════════

  blocks.push({ type: "divider", char: "=" });

  if (data.logoLines?.length) {
    blocks.push({ type: "spacer" });
    blocks.push({ type: "logo", lines: data.logoLines });
    if (data.dualBrandName?.trim()) {
      blocks.push({ type: "spacer" });
      blocks.push({ type: "center", text: `- ${data.dualBrandName.trim().toUpperCase()} -` });
    }
    blocks.push({ type: "spacer" });
  }

  blocks.push({ type: "divider", char: "=" });

  // ── Document title ───────────────────────────────────────────────────────────
  blocks.push({ type: "spacer" });
  blocks.push({ type: "center", text: spacedText("RECEIPT") });
  blocks.push({ type: "spacer" });

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

  const taxAmt = Number(data.tax ?? 0);
  if (taxAmt > 0) {
    blocks.push({ type: "totalLine", label: "Tax", amount: taxAmt });
  }

  blocks.push({ type: "divider", char: "=" });
  blocks.push({ type: "totalLine", label: "TOTAL", amount: data.total, strong: true });
  blocks.push({ type: "divider", char: "=" });

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
