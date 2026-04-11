import type { PrintBlock } from "../renderer";
import { money, formatDate } from "../formatter";

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
  // Branding options
  brandName?: string | null;
  footerMessage?: string | null;
  showDiscreetNotice?: boolean;
  showOperatorName?: boolean;
  logoLines?: string[];
}

export function buildCustomerReceiptBlocks(data: CustomerReceiptData): PrintBlock[] {
  const blocks: PrintBlock[] = [];

  // ── Header / Logo ────────────────────────────────────────────────────────────
  if (data.logoLines?.length) {
    blocks.push({ type: "logo", lines: data.logoLines });
    blocks.push({ type: "spacer" });
  }

  blocks.push({ type: "divider", char: "=" });
  blocks.push({ type: "center", text: "SECURE ORDER RECEIPT" });
  blocks.push({ type: "divider", char: "=" });

  // ── Order Info ───────────────────────────────────────────────────────────────
  blocks.push({ type: "kv", left: "Order #:", right: String(data.orderNumber ?? data.orderId) });
  blocks.push({ type: "kv", left: "Date:", right: formatDate(data.createdAt) });
  if (data.customerName) {
    blocks.push({ type: "kv", left: "Customer:", right: data.customerName });
  }
  if (data.fulfillmentType) {
    blocks.push({ type: "kv", left: "Type:", right: data.fulfillmentType });
  }
  if (data.showOperatorName !== false && data.operatorName) {
    blocks.push({ type: "kv", left: "Operator:", right: data.operatorName });
  }
  if (data.paymentStatus) {
    blocks.push({ type: "kv", left: "Payment:", right: data.paymentStatus.toUpperCase() });
  }
  if (data.paymentMethod) {
    blocks.push({ type: "kv", left: "Method:", right: data.paymentMethod });
  }

  // ── Notes ────────────────────────────────────────────────────────────────────
  if (data.notes) {
    blocks.push({ type: "divider", char: "-" });
    blocks.push({ type: "text", text: "NOTE:" });
    blocks.push({ type: "wrap", text: data.notes });
  }

  // ── Items ────────────────────────────────────────────────────────────────────
  blocks.push({ type: "divider", char: "-" });
  for (const item of data.items ?? []) {
    const qty = Number(item.quantity ?? 1);
    const unit = Number(item.unitPrice ?? 0);
    const total = Number(item.totalPrice ?? unit * qty);
    blocks.push({ type: "itemRow", name: item.name, qty, unitPrice: unit, total });
    if (item.notes) {
      blocks.push({ type: "text", text: `  * ${item.notes}` });
    }
  }

  // ── Totals ───────────────────────────────────────────────────────────────────
  blocks.push({ type: "divider", char: "-" });
  blocks.push({ type: "kv", left: "Subtotal:", right: money(data.subtotal) });
  if (Number(data.tax ?? 0) > 0) {
    blocks.push({ type: "kv", left: "Tax:", right: money(data.tax) });
  }
  blocks.push({ type: "kv", left: "TOTAL:", right: money(data.total) });
  blocks.push({ type: "divider", char: "=" });

  // ── Footer ───────────────────────────────────────────────────────────────────
  const footer = data.footerMessage?.trim()
    ?? "Thank you for your order.";
  blocks.push({ type: "spacer" });
  blocks.push({ type: "center", text: footer });

  if (data.showDiscreetNotice) {
    blocks.push({ type: "spacer" });
    blocks.push({ type: "center", text: "This receipt is confidential." });
    blocks.push({ type: "center", text: "Keep in a secure location." });
  }

  blocks.push({ type: "spacer", count: 2 });
  return blocks;
}
