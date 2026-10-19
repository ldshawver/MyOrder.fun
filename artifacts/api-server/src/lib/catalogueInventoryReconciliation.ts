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
