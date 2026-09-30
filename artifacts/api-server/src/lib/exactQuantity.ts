/** Fixed six decimal place physical quantity. Never routes through binary floating point. */
export function quantityUnits(value: string | number): bigint {
  const text = String(value);
  const match = /^(\d{1,14})(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw new Error("Invalid physical quantity");
  return BigInt(match[1]) * 1000000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

export function quantityText(units: bigint): string {
  const sign = units < 0n ? "-" : "";
  const absolute = units < 0n ? -units : units;
  return `${sign}${absolute / 1000000n}.${String(absolute % 1000000n).padStart(6, "0")}`;
}
