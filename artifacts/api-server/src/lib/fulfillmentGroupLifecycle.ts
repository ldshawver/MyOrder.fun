import {
  nextStateForOrderAction,
  type OrderLifecycleAction,
  type OrderLifecycleState,
} from "./orderStateMachine";

export type FulfillmentGroupProvider = "alavont" | "lucifer_direct" | "cj";

const STAFF_MANAGED_PROVIDERS = new Set<FulfillmentGroupProvider>(["alavont", "lucifer_direct"]);

export function assertStaffMayTransitionFulfillmentGroup(provider: string): asserts provider is FulfillmentGroupProvider {
  if (!STAFF_MANAGED_PROVIDERS.has(provider as FulfillmentGroupProvider)) {
    throw new Error("Staff cannot transition provider-managed fulfillment groups");
  }
}

export function transitionFulfillmentGroupStatus(from: unknown, target: OrderLifecycleState) {
  const action: OrderLifecycleAction =
    target === "in_progress" ? "claim" :
    target === "preparing" ? "prepare" :
    target === "ready" ? "ready" :
    target === "completed" ? "complete" :
    target === "cancelled" ? "cancel" :
    target === "refunded" ? "refund" :
    target === "reconciliation_required" ? "reconcile" :
    (() => { throw new Error(`Unsupported fulfillment group target: ${target}`); })();
  return nextStateForOrderAction(from, action);
}

export function deriveParentFulfillmentStatus(statuses: readonly OrderLifecycleState[]): OrderLifecycleState {
  if (statuses.length === 0) throw new Error("Cannot derive an order status without fulfillment groups");
  if (statuses.includes("reconciliation_required")) return "reconciliation_required";
  if (statuses.every((status) => status === "cancelled")) return "cancelled";

  const active = statuses.filter((status) => status !== "cancelled");
  if (active.every((status) => status === "completed")) return "completed";
  if (active.every((status) => status === "ready" || status === "completed")) return "ready";
  if (active.some((status) => status === "preparing" || status === "ready" || status === "completed")) return "preparing";
  if (active.some((status) => status === "in_progress")) return "in_progress";
  if (active.some((status) => status === "submitted")) return "submitted";
  return "draft";
}
