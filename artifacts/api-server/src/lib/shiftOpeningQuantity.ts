/** Opening count for a CSR box. A live balance wins over a typed or template number. */
export function shiftOpeningQuantity(input: {
  liveOnHand?: number | null;
  confirmedCount?: number | null;
  templateDefault?: number | null;
}): number {
  if (input.liveOnHand != null && Number.isFinite(input.liveOnHand)) return input.liveOnHand;
  if (input.confirmedCount != null && Number.isFinite(input.confirmedCount)) return input.confirmedCount;
  const fallback = Number(input.templateDefault ?? 0);
  return Number.isFinite(fallback) ? fallback : 0;
}
