// Read-only account tools for the Zappy assistant.
//
// Security model (enforced here, not by the prompt):
// - Every lookup is scoped to BOTH the authorized tenant AND the signed-in
//   user's own customer id, taken from the authenticated request, never from
//   model arguments. Staff/admins chatting with Zappy also only see their
//   own orders; operational views stay in the staff screens.
// - Rows are re-checked after loading (defense in depth) and anything that
//   isn't the caller's returns { found: false } — indistinguishable from
//   "doesn't exist", so order ids can't be probed.
// - Results are a small allow-listed projection: no payment tokens/intents,
//   addresses, internal notes or staff identities.
// - No tool here writes anything.

import { and, desc, eq, inArray } from "drizzle-orm";
import { db, ordersTable, orderItemsTable, customerCreditAccountsTable } from "@workspace/db";

export const ORDER_TOOL_NAMES = ["get_my_recent_orders", "get_my_order_status", "get_my_customer_credit"] as const;
export type OrderToolName = typeof ORDER_TOOL_NAMES[number];
export const MAX_RECENT_ORDERS = 5;
const MAX_ITEMS_PER_ORDER = 10;

export function isOrderTool(name: string): name is OrderToolName {
  return (ORDER_TOOL_NAMES as readonly string[]).includes(name);
}

export const ORDER_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "get_my_recent_orders",
      description: "Look up the signed-in customer's own most recent orders (newest first). Use for order history questions.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: `How many orders (1-${MAX_RECENT_ORDERS}, default 3)` } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_my_order_status",
      description: "Look up the live status of one of the signed-in customer's own orders by order number.",
      parameters: {
        type: "object",
        properties: { orderId: { type: "integer", description: "The order number" } },
        required: ["orderId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_my_customer_credit",
      description: "Look up the signed-in customer's own available Customer Credit balance.",
      parameters: { type: "object", properties: {} },
    },
  },
];

type OrderRow = Pick<typeof ordersTable.$inferSelect,
  "id" | "tenantId" | "customerId" | "status" | "paymentStatus" | "paymentMethod" | "fulfillmentStatus" | "deliveryMethod"
  | "total" | "createdAt" | "acceptedAt" | "estimatedReadyAt" | "readyAt" | "pickupAt" | "completedAt" | "cancelledAt" | "voidedAt" | "trackingUrl">;
type ItemRow = { orderId: number; catalogItemName: string; quantity: number };

export type OrderToolDeps = {
  loadRecentOrders: (tenantId: number, customerId: number, limit: number) => Promise<OrderRow[]>;
  loadOrder: (tenantId: number, customerId: number, orderId: number) => Promise<OrderRow | undefined>;
  loadItems: (orderIds: number[]) => Promise<ItemRow[]>;
  loadCredit: (tenantId: number, customerId: number) => Promise<{ balance: unknown; reservedBalance: unknown } | undefined>;
};

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const money = (v: unknown) => Number(Number(v ?? 0).toFixed(2));

/** Customer-facing status, derived only from recorded fields. */
export function describeOrderState(o: OrderRow): string {
  if (o.voidedAt) return "voided";
  if (o.cancelledAt || o.status === "cancelled") return "cancelled";
  if (o.completedAt || o.status === "completed" || o.fulfillmentStatus === "complete") return "completed";
  if (o.fulfillmentStatus === "handed_off") return o.deliveryMethod === "pickup" ? "picked up" : "out for delivery";
  if (o.fulfillmentStatus === "courier_arrived") return "courier has arrived for pickup";
  if (o.readyAt || o.fulfillmentStatus === "ready_behind_gate") return o.deliveryMethod === "pickup" ? "ready for pickup" : "ready, awaiting delivery";
  if (o.acceptedAt) return "being prepared";
  return "received, waiting to be accepted";
}

export function projectOrder(o: OrderRow, items: ItemRow[]) {
  const mine = items.filter(i => i.orderId === o.id);
  return {
    orderId: o.id,
    placedAt: iso(o.createdAt),
    state: describeOrderState(o),
    recordedStatus: o.status,
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    fulfillment: o.deliveryMethod ?? "pickup",
    total: money(o.total),
    items: mine.slice(0, MAX_ITEMS_PER_ORDER).map(i => ({ name: i.catalogItemName, quantity: i.quantity })),
    moreItems: Math.max(0, mine.length - MAX_ITEMS_PER_ORDER),
    estimatedReadyAt: iso(o.estimatedReadyAt),
    readyAt: iso(o.readyAt),
    scheduledPickupAt: iso(o.pickupAt),
    completedAt: iso(o.completedAt),
    // Only the provider's link as recorded; null means there is no tracking.
    deliveryTrackingUrl: o.trackingUrl && /^https:\/\//.test(o.trackingUrl) ? o.trackingUrl : null,
  };
}

function owns(o: OrderRow | undefined, tenantId: number, customerId: number): o is OrderRow {
  return !!o && o.tenantId === tenantId && o.customerId === customerId;
}

export async function runOrderTool(
  name: OrderToolName,
  rawArgs: unknown,
  ctx: { tenantId: number; customerId: number },
  deps: OrderToolDeps = defaultOrderToolDeps,
): Promise<Record<string, unknown>> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const { tenantId, customerId } = ctx;
  if (!Number.isInteger(tenantId) || !Number.isInteger(customerId)) return { error: "unavailable" };

  if (name === "get_my_recent_orders") {
    const n = Number(args.limit ?? 3);
    const limit = Number.isInteger(n) ? Math.min(Math.max(n, 1), MAX_RECENT_ORDERS) : 3;
    const rows = (await deps.loadRecentOrders(tenantId, customerId, limit)).filter(o => owns(o, tenantId, customerId)).slice(0, limit);
    const items = rows.length ? await deps.loadItems(rows.map(r => r.id)) : [];
    return { orders: rows.map(r => projectOrder(r, items)), count: rows.length };
  }

  if (name === "get_my_order_status") {
    const orderId = Number(args.orderId);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return { found: false };
    const row = await deps.loadOrder(tenantId, customerId, orderId);
    if (!owns(row, tenantId, customerId)) return { found: false };
    return { found: true, order: projectOrder(row, await deps.loadItems([row.id])) };
  }

  // get_my_customer_credit — read only; a missing account means no credit yet.
  const acct = await deps.loadCredit(tenantId, customerId);
  const balance = money(acct?.balance);
  const reserved = money(acct?.reservedBalance);
  return { availableCredit: money(balance - reserved), reservedForOpenOrders: reserved };
}

const orderColumns = {
  id: ordersTable.id, tenantId: ordersTable.tenantId, customerId: ordersTable.customerId, status: ordersTable.status,
  paymentStatus: ordersTable.paymentStatus, paymentMethod: ordersTable.paymentMethod, fulfillmentStatus: ordersTable.fulfillmentStatus,
  deliveryMethod: ordersTable.deliveryMethod, total: ordersTable.total, createdAt: ordersTable.createdAt, acceptedAt: ordersTable.acceptedAt,
  estimatedReadyAt: ordersTable.estimatedReadyAt, readyAt: ordersTable.readyAt, pickupAt: ordersTable.pickupAt,
  completedAt: ordersTable.completedAt, cancelledAt: ordersTable.cancelledAt, voidedAt: ordersTable.voidedAt, trackingUrl: ordersTable.trackingUrl,
};

export const defaultOrderToolDeps: OrderToolDeps = {
  loadRecentOrders: (tenantId, customerId, limit) => db.select(orderColumns).from(ordersTable)
    .where(and(eq(ordersTable.tenantId, tenantId), eq(ordersTable.customerId, customerId)))
    .orderBy(desc(ordersTable.createdAt)).limit(limit),
  loadOrder: async (tenantId, customerId, orderId) => (await db.select(orderColumns).from(ordersTable)
    .where(and(eq(ordersTable.id, orderId), eq(ordersTable.tenantId, tenantId), eq(ordersTable.customerId, customerId))).limit(1))[0],
  loadItems: orderIds => db.select({ orderId: orderItemsTable.orderId, catalogItemName: orderItemsTable.catalogItemName, quantity: orderItemsTable.quantity })
    .from(orderItemsTable).where(inArray(orderItemsTable.orderId, orderIds)),
  loadCredit: async (tenantId, customerId) => (await db.select({ balance: customerCreditAccountsTable.balance, reservedBalance: customerCreditAccountsTable.reservedBalance })
    .from(customerCreditAccountsTable)
    .where(and(eq(customerCreditAccountsTable.tenantId, tenantId), eq(customerCreditAccountsTable.customerId, customerId))).limit(1))[0],
};
