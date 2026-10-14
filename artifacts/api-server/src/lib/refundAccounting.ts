export type RefundTender = "customer_credit" | "cash" | "paypal";

export type OriginalTenderAllocation = {
  tender: RefundTender;
  amountCents: number;
};

export type OrderLineRefundTax = {
  lineIndex: number;
  orderItemId: number;
  catalogItemId: number;
  quantity: number;
  grossCents: number;
  discountCents: number;
  taxable: boolean;
  taxableBaseCents: number;
  taxCents: number;
};

export function parseOriginalTenderAllocations(value: unknown, orderTotalCents: number): OriginalTenderAllocation[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { schemaVersion?: unknown; totalCents?: unknown; allocations?: unknown };
  if (record.schemaVersion !== 1 || record.totalCents !== orderTotalCents || !Array.isArray(record.allocations)) return null;
  const allowed = new Set<RefundTender>(["customer_credit", "cash", "paypal"]);
  const allocations: OriginalTenderAllocation[] = [];
  const seen = new Set<string>();
  for (const row of record.allocations) {
    if (!row || typeof row !== "object") return null;
    const entry = row as { tender?: unknown; amountCents?: unknown };
    if (typeof entry.tender !== "string" || !allowed.has(entry.tender as RefundTender)
      || !Number.isSafeInteger(entry.amountCents) || Number(entry.amountCents) <= 0 || seen.has(entry.tender)) return null;
    seen.add(entry.tender);
    allocations.push({ tender: entry.tender as RefundTender, amountCents: Number(entry.amountCents) });
  }
  if (!allocations.length || allocations.reduce((sum, row) => sum + row.amountCents, 0) !== orderTotalCents) return null;
  // Checkout currently accepts one external tender plus optional Customer
  // Credit. Reject impossible historical three-way mixes: largest-remainder
  // apportionment is monotone for two sources, while Hamilton apportionment
  // can exhibit the Alabama paradox with three or more sources.
  if (allocations.length > 2 || (seen.has("cash") && seen.has("paypal"))) return null;
  return allocations;
}

function assertNonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be nonnegative integer cents`);
}

export function allocateCumulativeQuantityCents(input: { totalCents: number; totalQuantity: number; priorQuantity: number; currentQuantity: number }): number {
  assertNonnegativeInteger(input.totalCents, "totalCents");
  if (!Number.isSafeInteger(input.totalQuantity) || input.totalQuantity <= 0
    || !Number.isSafeInteger(input.priorQuantity) || input.priorQuantity < 0
    || !Number.isSafeInteger(input.currentQuantity) || input.currentQuantity <= 0
    || input.priorQuantity + input.currentQuantity > input.totalQuantity) throw new Error("Invalid cumulative return quantity");
  const round = (quantity: number) => Number((BigInt(input.totalCents) * BigInt(quantity) * 2n + BigInt(input.totalQuantity)) / (2n * BigInt(input.totalQuantity)));
  return round(input.priorQuantity + input.currentQuantity) - round(input.priorQuantity);
}

/** Largest-remainder allocation with a stable caller-supplied key for ties. */
export function allocateCentsByWeight<T extends { key: string; weight: number }>(amountCents: number, rows: readonly T[]): Array<T & { amountCents: number }> {
  assertNonnegativeInteger(amountCents, "amountCents");
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!Number.isSafeInteger(totalWeight) || rows.some(row => !Number.isSafeInteger(row.weight) || row.weight < 0)) throw new Error("Invalid allocation weights");
  if (amountCents > totalWeight) throw new Error("Allocation exceeds total weight");
  if (rows.length === 0) {
    if (amountCents !== 0) throw new Error("Cannot allocate cents without rows");
    return [];
  }
  if (totalWeight === 0) {
    if (amountCents !== 0) throw new Error("Cannot allocate positive cents across zero weights");
    return rows.map(row => ({ ...row, amountCents: 0 }));
  }
  const denominator = BigInt(totalWeight);
  const parts = rows.map(row => {
    const product = BigInt(amountCents) * BigInt(row.weight);
    return { row, base: Number(product / denominator), remainder: product % denominator };
  });
  let left = amountCents - parts.reduce((sum, part) => sum + part.base, 0);
  const priority = [...parts].sort((a, b) => a.remainder === b.remainder
    ? a.row.key.localeCompare(b.row.key)
    : a.remainder > b.remainder ? -1 : 1);
  const extra = new Set<string>();
  for (const part of priority) {
    if (left === 0) break;
    if (part.row.weight === 0) continue;
    extra.add(part.row.key);
    left -= 1;
  }
  if (left !== 0) throw new Error("Unable to allocate all cents");
  return parts.map(part => ({ ...part.row, amountCents: part.base + (extra.has(part.row.key) ? 1 : 0) }));
}

export function allocateOrderLineRefundTax(input: {
  lines: Array<{ lineIndex: number; orderItemId: number; catalogItemId: number; quantity: number; unitPriceCents: number; taxable: boolean }>;
  taxableDiscountCents: number;
  nonTaxableDiscountCents: number;
  taxCents: number;
}): OrderLineRefundTax[] {
  assertNonnegativeInteger(input.taxableDiscountCents, "taxableDiscountCents");
  assertNonnegativeInteger(input.nonTaxableDiscountCents, "nonTaxableDiscountCents");
  assertNonnegativeInteger(input.taxCents, "taxCents");
  const rows = input.lines.map(line => {
    if (!Number.isSafeInteger(line.lineIndex) || line.lineIndex < 0 || !Number.isSafeInteger(line.orderItemId) || line.orderItemId <= 0 || !Number.isSafeInteger(line.quantity) || line.quantity <= 0 || !Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents < 0) throw new Error("Invalid order line refund data");
    return { ...line, grossCents: line.unitPriceCents * line.quantity };
  });
  const taxable = rows.filter(line => line.taxable);
  const nonTaxable = rows.filter(line => !line.taxable);
  const taxableGross = taxable.reduce((sum, line) => sum + line.grossCents, 0);
  const nonTaxableGross = nonTaxable.reduce((sum, line) => sum + line.grossCents, 0);
  if (input.taxableDiscountCents > taxableGross || input.nonTaxableDiscountCents > nonTaxableGross) throw new Error("Discount allocation exceeds line merchandise");
  const taxableDiscounts = new Map(allocateCentsByWeight(input.taxableDiscountCents, taxable.map(line => ({ key: String(line.lineIndex), weight: line.grossCents }))).map(row => [Number(row.key), row.amountCents]));
  const nonTaxableDiscounts = new Map(allocateCentsByWeight(input.nonTaxableDiscountCents, nonTaxable.map(line => ({ key: String(line.lineIndex), weight: line.grossCents }))).map(row => [Number(row.key), row.amountCents]));
  const netTaxable = rows.map(line => ({
    line,
    discountCents: line.taxable ? (taxableDiscounts.get(line.lineIndex) ?? 0) : (nonTaxableDiscounts.get(line.lineIndex) ?? 0),
  })).map(entry => ({ ...entry, netCents: entry.line.grossCents - entry.discountCents }));
  const taxLines = netTaxable.filter(entry => entry.line.taxable);
  const taxAllocations = allocateCentsByWeight(input.taxCents, taxLines.map(entry => ({ key: String(entry.line.lineIndex), weight: entry.netCents })));
  const taxByLine = new Map(taxAllocations.map(row => [Number(row.key), row.amountCents]));
  return netTaxable.map(({ line, discountCents, netCents }) => ({
    lineIndex: line.lineIndex,
    orderItemId: line.orderItemId,
    catalogItemId: line.catalogItemId,
    quantity: line.quantity,
    grossCents: line.grossCents,
    discountCents,
    taxable: line.taxable,
    taxableBaseCents: line.taxable ? netCents : 0,
    taxCents: taxByLine.get(line.lineIndex) ?? 0,
  }));
}

/**
 * Compute each tender's cumulative target from the original tender shares,
 * then return only the additional cents due now. Prior source refunds that
 * exceed the new proportional target are treated as unreconcilable history.
 */
export function allocateProportionalRefund(input: {
  cumulativeRefundCents: number;
  original: readonly OriginalTenderAllocation[];
  alreadyRefunded: Readonly<Record<RefundTender, number>>;
}): Record<RefundTender, number> {
  assertNonnegativeInteger(input.cumulativeRefundCents, "cumulativeRefundCents");
  const original = input.original.filter(row => row.amountCents > 0);
  if (original.length > 2 || (original.some(row => row.tender === "cash") && original.some(row => row.tender === "paypal"))) throw new Error("Unsupported original tender combination");
  const total = original.reduce((sum, row) => sum + row.amountCents, 0);
  if (!original.length || input.cumulativeRefundCents > total) throw new Error("Refund exceeds original tender allocations");
  const targets = allocateCentsByWeight(input.cumulativeRefundCents, original.map(row => ({ key: row.tender, weight: row.amountCents })));
  const result: Record<RefundTender, number> = { customer_credit: 0, cash: 0, paypal: 0 };
  for (const row of original) {
    const already = input.alreadyRefunded[row.tender];
    assertNonnegativeInteger(already, `alreadyRefunded.${row.tender}`);
    if (already > row.amountCents) throw new Error(`Prior ${row.tender} refunds exceed the original allocation`);
    const target = targets.find(candidate => candidate.key === row.tender)?.amountCents ?? 0;
    if (already > target) throw new Error(`Prior ${row.tender} refunds conflict with proportional allocation`);
    result[row.tender] = target - already;
  }
  if (Object.values(result).reduce((sum, value) => sum + value, 0)
    !== input.cumulativeRefundCents - Object.values(input.alreadyRefunded).reduce((sum, value) => sum + value, 0)) throw new Error("Refund allocation does not reconcile");
  return result;
}
