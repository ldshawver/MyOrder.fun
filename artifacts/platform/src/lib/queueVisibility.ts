/** The general queue is an operational fallback, never customer-facing. */
export function shouldShowGeneralQueueBanner({
  canManageQueue,
  isCustomer,
  hasQueueStatus,
  hasActiveShift,
}: {
  canManageQueue: boolean;
  /** A customer must never receive operational queue state on any route. */
  isCustomer: boolean;
  hasQueueStatus: boolean;
  hasActiveShift: boolean;
}): boolean {
  return canManageQueue && !isCustomer && hasQueueStatus && !hasActiveShift;
}
