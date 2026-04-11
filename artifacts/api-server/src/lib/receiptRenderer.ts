/**
 * receiptRenderer.ts — Legacy-compatible shim.
 * Delegates to the modular print engine in ./print/.
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
  paymentMethod?: string;
  createdAt?: string | Date;
  // Branding
  paperWidth?: string;
  dualBrandName?: string;
  footerMessage?: string;
  showDiscreetNotice?: boolean;
  showOperatorName?: boolean;
  operatorName?: string;
  // Legacy (ignored)
  logoLines?: string[];
  brandName?: string;
}

export function renderKitchenTicket(order: PrintOrder): string {
  const width = charWidth(order.paperWidth ?? "80mm");
  const logoLines = getLogo(width);
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
