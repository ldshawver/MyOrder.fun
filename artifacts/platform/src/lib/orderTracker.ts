export type TrackerOrder = {
  createdAt: string;
  estimatedReadyAt?: string | null;
  readyAt?: string | null;
  fulfillmentStatus?: string | null;
  status: string;
  deliveryMethod?: string | null;
};

export function customerTracker(order: TrackerOrder, serverNowMs: number) {
  const state = order.fulfillmentStatus ?? order.status;
  const delivery = order.deliveryMethod === "uber_direct";
  if (["cancelled", "voided", "refunded"].includes(state)) return { phase: "cancelled", progress: 0, label: "Order cancelled", remainingMs: null };
  if (state === "completed" || state === "delivered") return { phase: "completed", progress: 1, label: "Order complete", remainingMs: 0 };
  if (order.readyAt || state === "ready") return { phase: "ready", progress: 1, label: delivery ? "Ready for delivery request" : "Ready for pickup", remainingMs: 0 };
  const created = Date.parse(order.createdAt);
  const eta = order.estimatedReadyAt ? Date.parse(order.estimatedReadyAt) : NaN;
  if (!Number.isFinite(created) || !Number.isFinite(eta) || !Number.isFinite(serverNowMs) || eta <= created) return { phase: "placed", progress: 0, label: "Order placed · estimated ready time pending", remainingMs: null };
  const progress = Math.max(0, Math.min(1, (serverNowMs - created) / (eta - created)));
  const remainingMs = Math.max(0, eta - serverNowMs);
  if (serverNowMs >= eta) return { phase: "overdue", progress: 1, label: "Finishing up · we'll notify you when it is ready", remainingMs: 0 };
  if (progress >= 0.7) return { phase: "packaging", progress, label: "Estimated progress: packaging your order", remainingMs };
  if (progress >= 0.1) return { phase: "preparing", progress, label: "Estimated progress: preparing your order", remainingMs };
  return { phase: "placed", progress, label: "Order placed", remainingMs };
}
