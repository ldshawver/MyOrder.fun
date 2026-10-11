export type TrackerOrder = {
  createdAt: string;
  acceptedAt?: string | null;
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
  if (state === "packaging") return { phase: "packaging", progress: 1, label: "Your order is being packaged", remainingMs: null };
  if (!order.acceptedAt) return { phase: "placed", progress: 0, label: "Order placed · waiting for preparation to start", remainingMs: null };
  const started = Date.parse(order.acceptedAt);
  const eta = order.estimatedReadyAt ? Date.parse(order.estimatedReadyAt) : NaN;
  if (!Number.isFinite(started) || !Number.isFinite(eta) || !Number.isFinite(serverNowMs) || eta <= started) return { phase: "placed", progress: 0, label: "Preparation estimate pending", remainingMs: null };
  const progress = Math.max(0, Math.min(1, (serverNowMs - started) / (eta - started)));
  const remainingMs = Math.max(0, eta - serverNowMs);
  if (serverNowMs >= eta) return { phase: "overdue", progress: 1, label: "Preparation is taking longer than estimated · we'll notify you when it is ready", remainingMs: 0 };
  return { phase: "preparing", progress, label: "Your order is being prepared · countdown is an estimate", remainingMs };
}
