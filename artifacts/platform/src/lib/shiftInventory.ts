/** Amount the box should still contain: recorded end, otherwise opening minus sold. */
export function expectedEndingQuantity(item: {
  quantityEnd?: number | null;
  quantityStart?: number | null;
  quantitySold?: number | null;
}): number {
  if (item.quantityEnd != null && Number.isFinite(Number(item.quantityEnd))) return Number(item.quantityEnd);
  const start = Number(item.quantityStart ?? 0);
  const sold = Number(item.quantitySold ?? 0);
  const value = (Number.isFinite(start) ? start : 0) - (Number.isFinite(sold) ? sold : 0);
  return Number.isFinite(value) ? value : 0;
}
