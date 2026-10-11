import { quantityText, quantityUnits } from "./exactQuantity";

export type OriginalSaleAllocation = { movementId: number; catalogItemId: number; locationId: number; quantity: string };
export type RestoredSaleAllocation = { saleMovementId: number; quantity: string };

/** Allocate physical restock quantity only across the immutable original sale
 * movements. A return can never select a mutable catalog source or location. */
export function planReturnRestoration(targetPhysicalQuantity: string, sales: OriginalSaleAllocation[], restored: RestoredSaleAllocation[]) {
  let remaining = quantityUnits(targetPhysicalQuantity);
  if (remaining < 0n) throw new Error("Return physical quantity cannot be negative");
  const already = new Map<number, bigint>();
  for (const row of restored) already.set(row.saleMovementId, (already.get(row.saleMovementId) ?? 0n) + quantityUnits(row.quantity));
  const result: Array<OriginalSaleAllocation & { restoreQuantity: string }> = [];
  for (const sale of [...sales].sort((a, b) => a.movementId - b.movementId)) {
    const sold = quantityUnits(sale.quantity);
    const restoredFromSale = already.get(sale.movementId) ?? 0n;
    if (restoredFromSale > sold) throw new Error("Previously restored stock exceeds the original sale movement");
    const capacity = sold - restoredFromSale;
    const amount = remaining < capacity ? remaining : capacity;
    if (amount > 0n) result.push({ ...sale, restoreQuantity: quantityText(amount) });
    remaining -= amount;
    if (remaining === 0n) return result;
  }
  if (remaining !== 0n) throw new Error("Return restock quantity exceeds original inventory allocations");
  return result;
}

/** Given a whole-unit order line and immutable total stock consumption, return
 * the exact stock quantity for a cumulative number of whole units. */
export function physicalQuantityForReturnedUnits(totalPhysical: string, purchasedUnits: number, restockedUnits: number): string {
  if (!Number.isSafeInteger(purchasedUnits) || purchasedUnits <= 0 || !Number.isSafeInteger(restockedUnits) || restockedUnits < 0 || restockedUnits > purchasedUnits) {
    throw new Error("Invalid purchased or returned quantity");
  }
  const total = quantityUnits(totalPhysical);
  if (total % BigInt(purchasedUnits) !== 0n) throw new Error("Snapshot physical quantity is not an exact per-unit multiple");
  return quantityText((total / BigInt(purchasedUnits)) * BigInt(restockedUnits));
}
