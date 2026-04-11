/**
 * receiptRenderer.ts — Legacy-compatible shim.
 * Delegates to the new modular print engine in ./print/.
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
  createdAt?: string | Date;
  // Optional branding overrides
  operatorName?: string;
  paperWidth?: string;
  logoLines?: string[];
  brandName?: string;
  footerMessage?: string;
  showDiscreetNotice?: boolean;
  showOperatorName?: boolean;
}

export function renderKitchenTicket(order: PrintOrder): string {
  const width = charWidth(order.paperWidth ?? "80mm");
  const logoLines = order.logoLines ?? getLogo(width, order.brandName);
  const blocks = buildCustomerReceiptBlocks({
    orderId: order.id,
    orderNumber: order.orderNumber,
    createdAt: order.createdAt,
    customerName: order.customerName,
    fulfillmentType: order.fulfillmentType ?? "Pickup",
    operatorName: order.operatorName,
    paymentStatus: order.paymentStatus,
    notes: order.notes,
    items: (order.items ?? []).map(i => ({
      name: i.name,
      quantity: i.quantity,
      unitPrice: i.unitPrice ?? 0,
      totalPrice: i.totalPrice ?? (i.unitPrice ?? 0) * i.quantity,
      notes: i.notes,
    })),
    subtotal: order.subtotal ?? 0,
    tax: order.tax,
    total: order.total ?? 0,
    logoLines,
    brandName: order.brandName,
    footerMessage: order.footerMessage,
    showDiscreetNotice: order.showDiscreetNotice ?? false,
    showOperatorName: order.showOperatorName ?? true,
  });
  return renderBlocks(blocks, width);
}

export function renderCustomerReceipt(order: PrintOrder): string {
  return renderKitchenTicket(order);
}
