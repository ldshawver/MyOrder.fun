export const ORDER_LIFECYCLE_STATES = [
  "draft",
  "submitted",
  "in_progress",
  "preparing",
  "ready",
  "completed",
  "cancelled",
  "refunded",
  "reconciliation_required",
] as const;

export type OrderLifecycleState = typeof ORDER_LIFECYCLE_STATES[number];

export type OrderLifecycleAction = "claim" | "prepare" | "ready" | "complete" | "cancel" | "refund" | "reconcile";

export class IllegalOrderTransitionError extends Error {
  readonly status = 409;
  constructor(
    public readonly from: OrderLifecycleState,
    public readonly to: OrderLifecycleState,
    public readonly action: OrderLifecycleAction,
  ) {
    super(`Illegal order lifecycle transition: ${from} -> ${to}`);
    this.name = "IllegalOrderTransitionError";
  }
}

const LEGACY_STATUS_MAP: Record<string, OrderLifecycleState> = {
  pending: "submitted",
  accepted: "in_progress",
  processing: "preparing",
  preparing: "preparing",
  ready_behind_gate: "ready",
  courier_arrived: "ready",
  delivered: "completed",
  handed_off: "completed",
  complete: "completed",
  voided: "cancelled",
  archived: "cancelled",
  failed: "reconciliation_required",
};

const ACTION_TARGET: Record<OrderLifecycleAction, OrderLifecycleState> = {
  claim: "in_progress",
  prepare: "preparing",
  ready: "ready",
  complete: "completed",
  cancel: "cancelled",
  refund: "refunded",
  reconcile: "reconciliation_required",
};

const LEGAL_TRANSITIONS: Record<OrderLifecycleState, readonly OrderLifecycleState[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["in_progress", "cancelled", "reconciliation_required"],
  in_progress: ["preparing", "ready", "cancelled", "reconciliation_required"],
  preparing: ["ready", "cancelled", "reconciliation_required"],
  ready: ["completed", "cancelled", "reconciliation_required"],
  completed: ["refunded", "reconciliation_required"],
  cancelled: ["reconciliation_required"],
  refunded: ["reconciliation_required"],
  reconciliation_required: [],
};

export function normalizeOrderLifecycleState(...candidates: Array<unknown>): OrderLifecycleState {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim().toLowerCase();
    if ((ORDER_LIFECYCLE_STATES as readonly string[]).includes(normalized)) return normalized as OrderLifecycleState;
    if (LEGACY_STATUS_MAP[normalized]) return LEGACY_STATUS_MAP[normalized];
  }
  return "submitted";
}

export function targetStateForAction(action: OrderLifecycleAction): OrderLifecycleState {
  return ACTION_TARGET[action];
}

export function isTerminalOrderLifecycleState(state: OrderLifecycleState): boolean {
  return state === "completed" || state === "cancelled" || state === "refunded" || state === "reconciliation_required";
}

export function assertLegalOrderTransition(
  from: OrderLifecycleState,
  to: OrderLifecycleState,
  action: OrderLifecycleAction,
): { changed: boolean } {
  if (from === to) return { changed: false };
  if (!(LEGAL_TRANSITIONS[from] ?? []).includes(to)) {
    throw new IllegalOrderTransitionError(from, to, action);
  }
  return { changed: true };
}

export function nextStateForOrderAction(fromRaw: unknown, action: OrderLifecycleAction): { from: OrderLifecycleState; to: OrderLifecycleState; changed: boolean } {
  const from = normalizeOrderLifecycleState(fromRaw);
  const to = targetStateForAction(action);
  const { changed } = assertLegalOrderTransition(from, to, action);
  return { from, to, changed };
}
