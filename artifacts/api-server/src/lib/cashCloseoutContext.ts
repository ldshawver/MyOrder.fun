/** The order's server-recorded routing owns cash accountability. */
export function usesGeneralQueueCashSession(routeSource: string | null, openSessionCount: number): boolean {
  return openSessionCount > 0 && routeSource !== "active_csr" && routeSource !== "supervisor_override";
}
