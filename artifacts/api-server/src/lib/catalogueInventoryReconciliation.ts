import { createHash } from "node:crypto";
import { quantityText, quantityUnits } from "./exactQuantity";

/** Conservative, exact conversions. Unknown cross-unit conversions fail closed. */
const unitFamily: Record<string, { family: string; perBase: bigint }> = {
  each: { family: "count", perBase: 1n }, ea: { family: "count", perBase: 1n }, piece: { family: "count", perBase: 1n }, pieces: { family: "count", perBase: 1n }, pcs: { family: "count", perBase: 1n },
  mg: { family: "mass", perBase: 1n }, g: { family: "mass", perBase: 1000n }, kg: { family: "mass", perBase: 1000000n },
  ml: { family: "volume", perBase: 1n }, l: { family: "volume", perBase: 1000n },
};

export function conversionRatio(fromUnit: string, toUnit: string): { numerator: bigint; denominator: bigint } {
  const from = fromUnit.trim().toLowerCase();
  const to = toUnit.trim().toLowerCase();
  if (!from || !to) throw new Error("A base unit is required");
  if (from === to) return { numerator: 1n, denominator: 1n };
  const a = unitFamily[from]; const b = unitFamily[to];
  if (!a || !b || a.family !== b.family) throw new Error(`No verified conversion exists from ${fromUnit} to ${toUnit}`);
  // Convert whole unit factors without floating point. The ratio is destination
  // quantity per source quantity, relative to the family’s canonical unit.
  const divisor = gcd(a.perBase, b.perBase);
  return { numerator: a.perBase / divisor, denominator: b.perBase / divisor };
}

function gcd(a: bigint, b: bigint): bigint { while (b) [a, b] = [b, a % b]; return a; }

export function convertQuantity(value: string, fromUnit: string, toUnit: string): string {
  const { numerator, denominator } = conversionRatio(fromUnit, toUnit);
  const raw = quantityUnits(value) * numerator;
  if (raw % denominator) throw new Error(`Conversion from ${fromUnit} to ${toUnit} exceeds six decimal places`);
  return quantityText(raw / denominator);
}

/** Multiply two six-decimal inventory quantities without floating point. */
export function multiplyQuantity(value: string, factor: string): string {
  const scale = 1_000_000n;
  const product = quantityUnits(value) * quantityUnits(factor);
  if (product % scale) throw new Error("Converted quantity exceeds six decimal places");
  return quantityText(product / scale);
}

function costUnits(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,12}))?$/.exec(value);
  if (!match) throw new Error("A positive verified unit cost is required");
  const scale = 1_000_000_000_000n;
  const amount = BigInt(match[1]) * scale + BigInt((match[2] ?? "").padEnd(12, "0"));
  if (amount <= 0n) throw new Error("A positive verified unit cost is required");
  return amount;
}

function costText(value: bigint): string {
  const scale = 1_000_000_000_000n;
  return `${value / scale}.${String(value % scale).padStart(12, "0")}`.replace(/0+$/, "").replace(/\.$/, "");
}

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("A positive source-unit conversion is required");
  const quotient = numerator / denominator;
  return (numerator % denominator) * 2n >= denominator ? quotient + 1n : quotient;
}

/** Convert cost per source package/unit to cost per target inventory unit. */
export function unitCostPerTargetQuantity(sourceUnitCost: string, sourceUnitQuantityInTargetUnit: string): string {
  const targetQuantity = quantityUnits(sourceUnitQuantityInTargetUnit);
  return costText(roundedDivide(costUnits(sourceUnitCost) * 1_000_000n, targetQuantity));
}

/** Convert cost per target inventory unit to cost per source package/unit. */
export function unitCostForSourceQuantity(targetUnitCost: string, sourceUnitQuantityInTargetUnit: string): string {
  const product = costUnits(targetUnitCost) * quantityUnits(sourceUnitQuantityInTargetUnit);
  return costText(roundedDivide(product, 1_000_000n));
}

export function convertUnitCost(value: string, fromUnit: string, toUnit: string): string {
  const { numerator, denominator } = conversionRatio(toUnit, fromUnit);
  const match = /^(\d+)(?:\.(\d{1,12}))?$/.exec(value);
  if (!match) throw new Error("A positive verified unit cost is required");
  const scale = 1_000_000_000_000n;
  const amount = BigInt(match[1]) * scale + BigInt((match[2] ?? "").padEnd(12, "0"));
  const converted = amount * numerator;
  if (converted % denominator) throw new Error("Converted cost exceeds twelve decimal places");
  const result = converted / denominator;
  if (result <= 0n) throw new Error("A positive verified unit cost is required");
  return `${result / scale}.${String(result % scale).padStart(12, "0")}`.replace(/0+$/, "").replace(/\.$/, "");
}

export function reconciliationFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
