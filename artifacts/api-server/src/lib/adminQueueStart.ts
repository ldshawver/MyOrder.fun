import { normalizeOrderLifecycleState } from "./orderStateMachine";

type QueueOrder = {
  status: string;
  fulfillmentStatus: string | null;
  routeSource: string | null;
  assignedCsrUserId: number | null;
  assignedShiftId: number | null;
  acceptedAt: Date | null;
};

export function canAdminStartDefaultQueueOrder(order: QueueOrder): boolean {
  // A supervisor's reassign-to-general action retains supervisor_override as
  // provenance. Older orders also retain stale routed_to=csr_shift; ownership
  // fields and route_source are the authoritative queue classification here.
  return (order.routeSource === "general_account" || order.routeSource === "supervisor_override")
    && order.assignedCsrUserId == null
    && order.assignedShiftId == null
    && order.acceptedAt == null
    && normalizeOrderLifecycleState(order.fulfillmentStatus, order.status) === "submitted";
}
