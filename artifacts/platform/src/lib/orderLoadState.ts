export function isOrderAccessFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const status = Number((error as { status?: unknown }).status);
  return status === 403 || status === 404;
}
