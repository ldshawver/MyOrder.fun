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
  total?: number;
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
  // Receipt line name mode (dual-brand)
  receiptLineNameMode?: "alavont_only" | "lucifer_only" | "both";
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
  const logoLines = getLogo(width);
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
    total: order.total ?? 0,
    logoLines,
    dualBrandName: order.dualBrandName,
    footerMessage: order.footerMessage,
    showDiscreetNotice: order.showDiscreetNotice ?? false,
    showOperatorName: order.showOperatorName ?? true,
  });
  return renderBlocks(blocks, width);
}

export function renderCustomerReceipt(order: PrintOrder): string {
  return renderKitchenTicket(order);
}
