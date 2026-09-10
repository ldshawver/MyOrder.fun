/**
 * receiptRenderer.ts — Legacy-compatible shim.
 * Delegates to the modular print engine in ./print/.
 * Supports receipt_line_name_mode: alavont_only | lucifer_only | both
 */
import {
  renderBlocks,
  buildCustomerReceiptBlocks,
  charWidth,
  getLogo,
} from "./print/index";

const STORED_NUL_PLACEHOLDER = "\u2400";

export function decodeStoredReceiptText(text: string): string {
  return text.replaceAll(STORED_NUL_PLACEHOLDER, "\x00");
}

interface OrderItem {
  quantity: number;
  name: string;
  alavontName?: string | null;
  luciferCruzName?: string | null;
  notes?: string;
  unitPrice?: number;
  totalPrice?: number;
}

interface PrintOrder {
  id: number;
  orderNumber?: string;
  fulfillmentType?: string;
  notes?: string;
  customerName?: string;
  items: OrderItem[];
  subtotal?: number;
  tax?: number;
  discount?: number;
  taxableSubtotal?: number;
  taxRate?: number;
  taxJurisdiction?: string;
  total?: number;
  customerCreditApplied?: number;
  remainingPaymentMethod?: string;
  remainingPaymentAmount?: number;
  cashTendered?: number;
  changeGiven?: number;
  providerCaptureReference?: string;
  remainingCustomerCreditBalance?: number;
  adjustmentTotal?: number;
  paymentStatus?: string;
  paymentMethod?: string;
  createdAt?: string | Date;
  // Branding
  paperWidth?: string;
  dualBrandName?: string;
  footerMessage?: string;
  showDiscreetNotice?: boolean;
  showOperatorName?: boolean;
  operatorName?: string;
  receiptTemplateStyle?: "clean" | "classic" | "compact";
  // Receipt line name mode (dual-brand)
  receiptLineNameMode?: "alavont_only" | "lucifer_only" | "both";
  receiptBrandName?: string;
  // Legacy (ignored)
  logoLines?: string[];
  brandName?: string;
}

function resolveItemName(item: OrderItem, mode: "alavont_only" | "lucifer_only" | "both"): string {
  if (mode === "alavont_only") {
    return item.alavontName ?? item.name;
  }
  if (mode === "lucifer_only") {
    return item.luciferCruzName ?? item.name;
  }
  return item.name;
}

function expandItemsForMode(items: OrderItem[], mode: "alavont_only" | "lucifer_only" | "both"): Array<{
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  notes?: string;
}> {
  const result: Array<{ name: string; quantity: number; unitPrice: number; totalPrice: number; notes?: string }> = [];

  for (const item of items) {
    const qty = item.quantity;
    const unit = item.unitPrice ?? 0;
    const total = item.totalPrice ?? unit * qty;

    if (mode === "both") {
      const aName = item.alavontName ?? item.name;
      const lcName = item.luciferCruzName ?? item.name;
      result.push({ name: aName, quantity: qty, unitPrice: unit, totalPrice: total, notes: item.notes });
      if (lcName !== aName) {
        result.push({ name: `LC: ${lcName}`, quantity: qty, unitPrice: 0, totalPrice: 0, notes: undefined });
      }
    } else {
      const name = resolveItemName(item, mode);
      result.push({ name, quantity: qty, unitPrice: unit, totalPrice: total, notes: item.notes });
    }
  }

  return result;
}

export function renderKitchenTicket(order: PrintOrder): string {
  const width = charWidth(order.paperWidth ?? "80mm");
  const logoLines = getLogo(width, order.receiptBrandName);
  const mode = order.receiptLineNameMode ?? "lucifer_only";
  const resolvedItems = expandItemsForMode(order.items ?? [], mode);

  const blocks = buildCustomerReceiptBlocks({
    orderId: order.id,
    orderNumber: order.orderNumber,
    createdAt: order.createdAt,
    customerName: order.customerName,
    fulfillmentType: order.fulfillmentType ?? "Pickup",
    operatorName: order.operatorName,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    notes: order.notes,
    items: resolvedItems,
    subtotal: order.subtotal ?? 0,
    tax: order.tax,
    discount: order.discount,
    taxableSubtotal: order.taxableSubtotal,
    taxRate: order.taxRate,
    taxJurisdiction: order.taxJurisdiction,
    total: order.total ?? 0,
    customerCreditApplied: order.customerCreditApplied,
    remainingPaymentMethod: order.remainingPaymentMethod,
    remainingPaymentAmount: order.remainingPaymentAmount,
    cashTendered: order.cashTendered,
    changeGiven: order.changeGiven,
    providerCaptureReference: order.providerCaptureReference,
    remainingCustomerCreditBalance: order.remainingCustomerCreditBalance,
    adjustmentTotal: order.adjustmentTotal,
    logoLines,
    dualBrandName: order.dualBrandName,
    footerMessage: order.footerMessage,
    showDiscreetNotice: order.showDiscreetNotice ?? false,
    showOperatorName: order.showOperatorName ?? true,
    receiptTemplateStyle: order.receiptTemplateStyle ?? "clean",
  });
  // PostgreSQL text columns reject NUL bytes. Keep the queued/rendered receipt
  // human-readable and reversible; the transport restores NUL before dispatch.
  return renderBlocks(blocks, width).replaceAll("\x00", STORED_NUL_PLACEHOLDER);
}

export function renderCustomerReceipt(order: PrintOrder): string {
  return renderKitchenTicket(order);
}
