import { formatMoneyCents, requiredNonNegativeMoneyCents } from "./shiftCloseoutFinancials";

const QUANTITY = /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/;
const REPLACEMENT_RATE_PERCENT = 80n;

export const CONTRACTOR_SHORTAGE_RATE = "0.200000";
export const CONTRACTOR_SHORTAGE_REPLACEMENT_RATE = "0.800000";
export const CONTRACTOR_SHORTAGE_REMAINDER_POLICY = "carry_forward_to_future_shift_payout" as const;

export type ShiftInventoryAccountabilityInput = {
  shiftInventoryItemId: number;
  catalogItemId: number | null;
  locationId: number | null;
  itemName: string;
  unitOfMeasure: string;
  openingQuantity: unknown;
  recordedSalesQuantity: unknown;
  nonSaleMovementDelta: unknown;
  countedQuantity: unknown;
  retailPrice: unknown;
};

export type ShiftInventoryShortageLine = {
  shiftInventoryItemId: number;
  catalogItemId: number;
  locationId: number;
  itemName: string;
  unitOfMeasure: string;
  openingQuantity: string;
  nonSaleMovementDelta: string;
  recordedSalesQuantity: string;
  expectedQuantity: string;
  countedQuantity: string;
  missingQuantity: string;
  retailPrice: string;
  discountRate: typeof CONTRACTOR_SHORTAGE_RATE;
  replacementRate: typeof CONTRACTOR_SHORTAGE_REPLACEMENT_RATE;
  unitReplacementValue: string;
  lineTotal: string;
};

export type ShiftInventoryAccountability = {
  lines: ShiftInventoryShortageLine[];
  blockers: Array<{ shiftInventoryItemId: number; itemName: string; code: string; message: string }>;
  total: string;
};

function quantityUnits(value: unknown, field: string): bigint {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!QUANTITY.test(text)) throw new Error(`${field} must be a non-negative quantity with at most three decimal places`);
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 1000n + BigInt((fraction + "000").slice(0, 3));
}

function signedQuantityUnits(value: unknown, field: string): bigint {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const units = quantityUnits(unsigned, field);
  return negative ? -units : units;
}

function formatQuantity(units: bigint): string {
  const negative = units < 0n;
  const unsigned = negative ? -units : units;
  const fraction = String(unsigned % 1000n).padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${unsigned / 1000n}${fraction ? `.${fraction}` : ""}`;
}

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

export function calculateShiftInventoryAccountability(inputs: ShiftInventoryAccountabilityInput[]): ShiftInventoryAccountability {
  const lines: ShiftInventoryShortageLine[] = [];
  const blockers: ShiftInventoryAccountability["blockers"] = [];
  let totalCents = 0n;

  for (const input of inputs) {
    const block = (code: string, message: string) => blockers.push({
      shiftInventoryItemId: input.shiftInventoryItemId,
      itemName: input.itemName,
      code,
      message,
    });
    if (!input.catalogItemId) { block("CATALOG_ITEM_REQUIRED", "Link this shift row to the exact product or variant before finalizing."); continue; }
    if (!input.locationId) { block("LOCATION_REQUIRED", "Assign this shift row to an inventory location before finalizing."); continue; }
    if (input.countedQuantity == null || input.countedQuantity === "") { block("PHYSICAL_COUNT_REQUIRED", "Enter the CSR's independent physical count before finalizing."); continue; }

    let opening: bigint;
    let sales: bigint;
    let movementDelta: bigint;
    let counted: bigint;
    try {
      opening = quantityUnits(input.openingQuantity, "openingQuantity");
      sales = quantityUnits(input.recordedSalesQuantity, "recordedSalesQuantity");
      movementDelta = signedQuantityUnits(input.nonSaleMovementDelta, "nonSaleMovementDelta");
      counted = quantityUnits(input.countedQuantity, "countedQuantity");
    } catch (error) {
      block("INVALID_QUANTITY", error instanceof Error ? error.message : "Inventory quantities are invalid.");
      continue;
    }
    const expected = opening + movementDelta - sales;
    if (expected < 0n) { block("NEGATIVE_EXPECTED_INVENTORY", "Recorded inventory activity produces a negative expected quantity; reconcile the ledger first."); continue; }
    const missing = expected > counted ? expected - counted : 0n;
    if (missing === 0n) continue;

    let retailCents: bigint;
    try {
      retailCents = requiredNonNegativeMoneyCents(input.retailPrice, "retailPrice");
    } catch {
      block("RETAIL_PRICE_REQUIRED", "Set an unambiguous retail price on this exact product or variant before finalizing.");
      continue;
    }
    if (retailCents <= 0n) { block("RETAIL_PRICE_REQUIRED", "Set a positive retail price on this exact product or variant before finalizing."); continue; }
    const replacementCents = roundRatio(retailCents * REPLACEMENT_RATE_PERCENT, 100n);
    const lineTotalCents = roundRatio(replacementCents * missing, 1000n);
    totalCents += lineTotalCents;
    lines.push({
      shiftInventoryItemId: input.shiftInventoryItemId,
      catalogItemId: input.catalogItemId,
      locationId: input.locationId,
      itemName: input.itemName,
      unitOfMeasure: input.unitOfMeasure,
      openingQuantity: formatQuantity(opening),
      nonSaleMovementDelta: formatQuantity(movementDelta),
      recordedSalesQuantity: formatQuantity(sales),
      expectedQuantity: formatQuantity(expected),
      countedQuantity: formatQuantity(counted),
      missingQuantity: formatQuantity(missing),
      retailPrice: formatMoneyCents(retailCents),
      discountRate: CONTRACTOR_SHORTAGE_RATE,
      replacementRate: CONTRACTOR_SHORTAGE_REPLACEMENT_RATE,
      unitReplacementValue: formatMoneyCents(replacementCents),
      lineTotal: formatMoneyCents(lineTotalCents),
    });
  }

  return { lines, blockers, total: formatMoneyCents(totalCents) };
}

export function applyAccountabilityOffsets(payable: unknown, priorRemainder: unknown, currentShortage: unknown) {
  const payableCents = requiredNonNegativeMoneyCents(payable, "payable");
  const priorCents = requiredNonNegativeMoneyCents(priorRemainder, "priorRemainder");
  const currentCents = requiredNonNegativeMoneyCents(currentShortage, "currentShortage");
  const priorApplied = priorCents < payableCents ? priorCents : payableCents;
  const afterPrior = payableCents - priorApplied;
  const currentApplied = currentCents < afterPrior ? currentCents : afterPrior;
  return {
    grossPayable: formatMoneyCents(payableCents),
    priorOffsetApplied: formatMoneyCents(priorApplied),
    currentOffsetApplied: formatMoneyCents(currentApplied),
    netPayout: formatMoneyCents(afterPrior - currentApplied),
    priorRemainder: formatMoneyCents(priorCents - priorApplied),
    currentRemainder: formatMoneyCents(currentCents - currentApplied),
    totalRemainder: formatMoneyCents(priorCents + currentCents - priorApplied - currentApplied),
    remainderPolicy: CONTRACTOR_SHORTAGE_REMAINDER_POLICY,
  };
}
