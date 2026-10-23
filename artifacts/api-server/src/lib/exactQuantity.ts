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

/** Parses a signed 12-place ledger total into the six-place physical scale. */
export function ledgerQuantityUnits(value: string | number): bigint {
  const text = String(value);
  const match = /^(-?)(\d{1,14})(?:\.(\d{1,12}))?$/.exec(text);
  if (!match) throw new Error("Invalid inventory ledger quantity");
  const fraction = match[3] ?? "";
  if (/[^0]/.test(fraction.slice(6))) throw new Error("Inventory ledger precision exceeds physical balance precision");
  const units = BigInt(match[2]) * 1000000n + BigInt(fraction.slice(0, 6).padEnd(6, "0"));
  return match[1] === "-" ? -units : units;
}
