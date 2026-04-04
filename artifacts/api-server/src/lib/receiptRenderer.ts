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
}

function money(n: number | null | undefined): string {
  return `$${Number(n ?? 0).toFixed(2)}`;
}

function padRight(str: string, len: number): string {
  const s = String(str ?? "");
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function formatTime(d: string | Date | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function renderKitchenTicket(order: PrintOrder): string {
  const lines: string[] = [];
  lines.push("================================");
  lines.push("          NEW ORDER             ");
  lines.push("================================");
  lines.push(`Order #: ${order.orderNumber ?? order.id}`);
  lines.push(`Type: ${order.fulfillmentType ?? "Pickup"}`);
  lines.push(`Time: ${formatTime(order.createdAt)}`);
  if (order.customerName) lines.push(`Name: ${order.customerName}`);
  if (order.notes) {
    lines.push("--------------------------------");
    lines.push("NOTES:");
    lines.push(order.notes);
  }
  lines.push("--------------------------------");
  for (const item of order.items ?? []) {
    lines.push(`${item.quantity} x ${item.name}`);
    if (item.notes) lines.push(`  * ${item.notes}`);
  }
  lines.push("--------------------------------");
  lines.push(`Payment: ${order.paymentStatus ?? "Pending"}`);
  lines.push("================================");
  lines.push("");
  lines.push("");
  return lines.join("\n");
}

export function renderCustomerReceipt(order: PrintOrder): string {
  const lines: string[] = [];
  lines.push("================================");
  lines.push("        ORDER RECEIPT           ");
  lines.push("================================");
  lines.push(`Order #: ${order.orderNumber ?? order.id}`);
  lines.push(`Date: ${formatTime(order.createdAt)}`);
  lines.push("--------------------------------");
  for (const item of order.items ?? []) {
    const label = `${item.quantity} x ${item.name}`;
    const price = money((item.unitPrice ?? 0) * (item.quantity ?? 1));
    lines.push(`${padRight(label, 26)}${price}`);
    if (item.notes) lines.push(`  * ${item.notes}`);
  }
  lines.push("--------------------------------");
  lines.push(`${padRight("Subtotal", 26)}${money(order.subtotal)}`);
  lines.push(`${padRight("Tax", 26)}${money(order.tax)}`);
  lines.push(`${padRight("Total", 26)}${money(order.total)}`);
  lines.push("--------------------------------");
  lines.push(`Payment: ${order.paymentStatus ?? "Pending"}`);
  lines.push("");
  lines.push("   Thank you — Alavont          ");
  lines.push("");
  lines.push("");
  return lines.join("\n");
}
