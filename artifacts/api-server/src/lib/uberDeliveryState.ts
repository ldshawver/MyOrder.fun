const progress = ["pending", "pickup", "pickup_complete", "dropoff", "delivered"] as const;
const failure = new Set(["canceled", "cancelled", "returned"]);

/** Uber events can be duplicated or arrive out of order. Never regress a delivery. */
export function nextUberDeliveryStatus(current: string | null, incoming: string): string | null {
  const next = incoming.toLowerCase();
  const prior = current?.toLowerCase() ?? null;
  if (prior === next) return null;
  if (prior === "delivered" || (prior && failure.has(prior))) return null;
  if (failure.has(next)) return next === "cancelled" ? "canceled" : next;
  const nextIndex = progress.indexOf(next as typeof progress[number]);
  if (nextIndex < 0) return null;
  if (!prior) return next;
  const priorIndex = progress.indexOf(prior as typeof progress[number]);
  return nextIndex > priorIndex ? next : null;
}
