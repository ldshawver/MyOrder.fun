import { z } from "zod";
import type { OrderLifecycleState } from "./orderStateMachine";

const ProviderEvent = z.object({
  eventId: z.string().trim().min(1).max(200),
  eventType: z.string().trim().min(1).max(200),
  providerOrderId: z.string().trim().min(1).max(200),
  status: z.enum(["pending", "processing", "on_hold", "completed", "cancelled", "failed", "refunded"]),
  occurredAt: z.string().datetime({ offset: true }).optional(),
}).strict();

export type CjProviderStatus = z.infer<typeof ProviderEvent>["status"];
export type CjProviderEvent = Omit<z.infer<typeof ProviderEvent>, "occurredAt"> & { occurredAt: Date | null };

const STATUS_RANK: Record<CjProviderStatus, number> = {
  pending: 0,
  processing: 1,
  on_hold: 1,
  completed: 2,
  cancelled: 2,
  failed: 2,
  refunded: 3,
};

export function parseCjProviderEvent(input: unknown): CjProviderEvent {
  const event = ProviderEvent.parse(input);
  return { ...event, occurredAt: event.occurredAt ? new Date(event.occurredAt) : null };
}

export function groupStatusForCjProviderStatus(status: CjProviderStatus): OrderLifecycleState {
  switch (status) {
    case "pending": return "submitted";
    case "processing": return "preparing";
    case "completed": return "completed";
    case "cancelled": return "cancelled";
    case "refunded": return "refunded";
    case "on_hold":
    case "failed": return "reconciliation_required";
  }
}

export type CjEventDecision =
  | { action: "apply"; providerStatus: CjProviderStatus; groupStatus: OrderLifecycleState }
  | { action: "idempotent" }
  | { action: "reconcile"; reason: "stale_event" | "provider_status_conflict" };

/**
 * Decide how an authenticated, identity-bound CJ event may change state.
 * Event identity/payload-hash replay checks happen in the durable inbox; this
 * policy prevents an older or conflicting provider state from regressing a
 * fulfillment group after the inbox row has been claimed.
 */
export function decideCjEventTransition(input: {
  currentProviderStatus: CjProviderStatus;
  incomingProviderStatus: CjProviderStatus;
  lastProviderEventAt: Date | null;
  incomingProviderEventAt: Date | null;
}): CjEventDecision {
  const { currentProviderStatus: current, incomingProviderStatus: incoming } = input;
  if (input.lastProviderEventAt && input.incomingProviderEventAt && input.incomingProviderEventAt < input.lastProviderEventAt) {
    return { action: "reconcile", reason: "stale_event" };
  }
  if (current === incoming) return { action: "idempotent" };

  const currentRank = STATUS_RANK[current];
  const incomingRank = STATUS_RANK[incoming];
  const allowedRefund = current === "completed" && incoming === "refunded";
  if (incomingRank < currentRank || (currentRank >= 2 && !allowedRefund)) {
    return { action: "reconcile", reason: "provider_status_conflict" };
  }
  return { action: "apply", providerStatus: incoming, groupStatus: groupStatusForCjProviderStatus(incoming) };
}
