/** The general queue is an operational fallback, never customer-facing. */
export function shouldShowGeneralQueueBanner({
  canManageQueue,
  customerStorefront,
  hasQueueStatus,
  hasActiveShift,
}: {
  canManageQueue: boolean;
  customerStorefront: boolean;
  hasQueueStatus: boolean;
  hasActiveShift: boolean;
}): boolean {
  return canManageQueue && !customerStorefront && hasQueueStatus && !hasActiveShift;
}
