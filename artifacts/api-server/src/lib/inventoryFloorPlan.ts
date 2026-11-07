export const FLOOR_LOCAL_CATALOG_SQL = [
  "ci.is_available = true",
  "ci.is_local_alavont = true",
  "COALESCE(ci.metadata->>'archived', 'false') <> 'true'",
  "COALESCE(ci.metadata->>'complianceHold', 'false') <> 'true'",
  "COALESCE(ci.metadata->>'safeOnlyDuplicate', 'false') <> 'true'",
  "ci.metadata->>'mergedIntoCatalogItemId' IS NULL",
].join(" AND ");

export type FloorEntityType = "catalog" | "non_catalog";
export type FloorScope = "one" | "all";
export type FloorNoteKind = "add_item" | "change_item" | "general";
export type FloorOutcome = "unchanged" | "corrected" | "opened" | "received" | "skipped";

export type FloorLocation = { id: number; name: string; type: string; displayOrder: number };

export type FloorSheetItem = {
  entityType: FloorEntityType;
  itemId: number;
  name: string;
  subtitle: string | null;
  unit: string;
  category: string;
  costHint: string | null;
  locations: Array<{ locationId: number; bookQuantity: string | null; hasBalance: boolean }>;
};

export type FloorStop = {
  locationId: number;
  locationName: string;
  entityType: FloorEntityType;
  itemId: number;
  name: string;
  subtitle: string | null;
  unit: string;
  category: string;
  bookQuantity: string | null;
  hasBalance: boolean;
  costHint: string | null;
};

export type CountPlan =
  | { action: "unchanged" }
  | { action: "opening"; quantity: string; needsUnitCost: boolean }
  | { action: "correction"; direction: "increase" | "decrease"; quantity: string };

const WHOLE_AND_FRACTION = /^(\d+)(?:\.(\d+))?$/;

/** Accepts typed quantities such as "03" and "3.50" and returns a canonical decimal. */
export function canonicalizeFloorDecimal(value: string): string | null {
  const trimmed = value.trim().endsWith(".") ? value.trim().slice(0, -1) : value.trim();
  const match = WHOLE_AND_FRACTION.exec(trimmed);
  if (!match) return null;
  const wholeRaw = match[1] ?? "";
  const fractionRaw = match[2] ?? "";
  if (wholeRaw.length > 12 || fractionRaw.length > 12) return null;
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionRaw.replace(/0+$/, "");
  const canonical = fraction ? `${whole}.${fraction}` : whole;
  return /^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/.test(canonical) ? canonical : null;
}

export function canonicalizeFloorCost(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const parsed = canonicalizeFloorDecimal(value);
  if (parsed == null || parsed === "0") return null;
  return parsed;
}

function toScaled(value: string): bigint {
  const negative = value.startsWith("-");
  const canonical = canonicalizeFloorDecimal(negative ? value.slice(1) : value);
  if (canonical == null) throw new Error("Quantity is not a decimal");
  const [whole, fraction = ""] = canonical.split(".");
  const scaled = BigInt(whole) * (10n ** 12n) + BigInt((fraction + "000000000000").slice(0, 12));
  return negative ? -scaled : scaled;
}

function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** 12n;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(12, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

export function compareFloorQuantity(left: string, right: string): -1 | 0 | 1 {
  const delta = toScaled(left) - toScaled(right);
  if (delta === 0n) return 0;
  return delta > 0n ? 1 : -1;
}

export function subtractFloorQuantity(left: string, right: string): string {
  return fromScaled(toScaled(left) - toScaled(right));
}

export function formatFloorQuantity(value: string | null | undefined): string {
  if (value == null || value.trim() === "") return "Not counted";
  const negative = value.trim().startsWith("-");
  const canonical = canonicalizeFloorDecimal(negative ? value.trim().slice(1) : value);
  if (canonical == null) return value.trim();
  return negative ? `-${canonical}` : canonical;
}

export function planPhysicalCount(bookQuantity: string | null, countedQuantity: string): CountPlan {
  const counted = canonicalizeFloorDecimal(countedQuantity);
  if (counted == null) throw new Error("Enter a quantity like 12 or 3.5");
  if (bookQuantity == null) return { action: "opening", quantity: counted, needsUnitCost: counted !== "0" };
  const book = canonicalizeFloorDecimal(bookQuantity.trim().startsWith("-") ? bookQuantity.trim().slice(1) : bookQuantity);
  if (book == null) throw new Error("The book quantity could not be read");
  const signedBook = bookQuantity.trim().startsWith("-") ? `-${book}` : book;
  const delta = subtractFloorQuantity(counted, signedBook);
  if (delta === "0") return { action: "unchanged" };
  if (delta.startsWith("-")) return { action: "correction", direction: "decrease", quantity: delta.slice(1) };
  return { action: "correction", direction: "increase", quantity: delta };
}

export function valuationCanFundIncrease(costStatus: string | null | undefined, average: string | null | undefined): boolean {
  return costStatus === "known" && canonicalizeFloorCost(average) != null;
}

export function pickCostHint(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const cost = canonicalizeFloorCost(candidate);
    if (cost) return cost;
  }
  return null;
}

export function openingUnitCost(explicit: string | null | undefined, average: string | null | undefined, hint: string | null | undefined): string | null {
  return canonicalizeFloorCost(explicit) ?? canonicalizeFloorCost(average) ?? canonicalizeFloorCost(hint);
}

export function walkLocationIds(locationIdsInDisplayOrder: number[], startId: number, scope: FloorScope): number[] {
  const start = locationIdsInDisplayOrder.indexOf(startId);
  if (start < 0) return [];
  if (scope === "one") return [startId];
  return [...locationIdsInDisplayOrder.slice(start), ...locationIdsInDisplayOrder.slice(0, start)];
}

export type RawFloorProduct = {
  entityType: FloorEntityType;
  itemId: number;
  name: string;
  subtitle: string | null;
  unit: string;
  category: string;
  special: boolean;
  costCandidates: Array<string | null>;
  balances: Array<{ locationId: number; quantity: string }>;
};

export function buildFloorSheet(locations: FloorLocation[], products: RawFloorProduct[]): FloorSheetItem[] {
  const ordered = [...locations].sort((left, right) => left.displayOrder - right.displayOrder || left.id - right.id);
  return products
    .filter(product => !product.special)
    .map((product): FloorSheetItem => ({
      entityType: product.entityType,
      itemId: product.itemId,
      name: product.name.trim() || "Untitled item",
      subtitle: product.subtitle && product.subtitle.trim() !== product.name.trim() ? product.subtitle.trim() : null,
      unit: product.unit.trim() || "each",
      category: product.category.trim() || "Uncategorized",
      costHint: pickCostHint(product.costCandidates),
      locations: ordered.map(location => {
        const balance = product.balances.find(row => row.locationId === location.id);
        return balance
          ? { locationId: location.id, bookQuantity: balance.quantity, hasBalance: true }
          : { locationId: location.id, bookQuantity: null, hasBalance: false };
      }),
    }))
    .sort((left, right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name) || left.entityType.localeCompare(right.entityType) || left.itemId - right.itemId);
}

export function buildCountStops(items: FloorSheetItem[], locations: FloorLocation[], startLocationId: number, scope: FloorScope): FloorStop[] {
  const ordered = [...locations].sort((left, right) => left.displayOrder - right.displayOrder || left.id - right.id);
  const names = new Map(ordered.map(location => [location.id, location.name]));
  const walk = walkLocationIds(ordered.map(location => location.id), startLocationId, scope);
  const stops: FloorStop[] = [];
  for (const locationId of walk) {
    for (const item of items) {
      const balance = item.locations.find(row => row.locationId === locationId);
      stops.push({
        locationId,
        locationName: names.get(locationId) ?? "Location",
        entityType: item.entityType,
        itemId: item.itemId,
        name: item.name,
        subtitle: item.subtitle,
        unit: item.unit,
        category: item.category,
        bookQuantity: balance?.hasBalance ? balance.bookQuantity : null,
        hasBalance: balance?.hasBalance === true,
        costHint: item.costHint,
      });
    }
  }
  return stops;
}

export function floorIdempotencyKey(kind: "count" | "receive", sessionId: number, locationId: number, entityType: FloorEntityType, itemId: number, attempt: number): string {
  const key = `floor-${kind === "count" ? "c" : "r"}-${sessionId}-${locationId}-${entityType}-${itemId}-${attempt}`;
  if (key.length > 120) throw new Error("Inventory idempotency key is too long");
  return key;
}

export function floorAttempt(value: unknown): number | null {
  const attempt = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 20) return null;
  return attempt;
}

/** Catalog on-hand is numeric(20,6). Supply balances and receipt quantities are numeric(10,3). */
export function floorQuantityFitsBalance(entityType: FloorEntityType, quantity: string): boolean {
  if (entityType === "non_catalog") return /^(?:0|[1-9]\d{0,6})(?:\.\d{1,3})?$/.test(quantity);
  return /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(quantity);
}

export type FloorLineIdentity = { locationId: number; entityType: string; itemId: number; attempt: number; outcome: string };

export function latestFloorLines<T extends FloorLineIdentity>(lines: T[]): T[] {
  const latest = new Map<string, T>();
  for (const line of lines) {
    const key = `${line.locationId}:${line.entityType}:${line.itemId}`;
    const previous = latest.get(key);
    if (!previous || line.attempt >= previous.attempt) latest.set(key, line);
  }
  return [...latest.values()];
}

export function nextStopIndex(stops: Array<{ locationId: number; entityType: string; itemId: number }>, lines: Array<{ locationId: number; entityType: string; itemId: number }>): number {
  const done = new Set(lines.map(line => `${line.locationId}:${line.entityType}:${line.itemId}`));
  const index = stops.findIndex(stop => !done.has(`${stop.locationId}:${stop.entityType}:${stop.itemId}`));
  return index === -1 ? stops.length : index;
}

export function summarizeFloorLines(lines: FloorLineIdentity[]): Record<FloorOutcome, number> {
  const summary: Record<FloorOutcome, number> = { unchanged: 0, corrected: 0, opened: 0, received: 0, skipped: 0 };
  for (const line of latestFloorLines(lines)) {
    if (line.outcome in summary) summary[line.outcome as FloorOutcome] += 1;
  }
  return summary;
}

export function countCheer(index: number, total: number): string {
  if (total <= 0) return "Nothing to count here.";
  if (index <= 0) return "First one. You've got this.";
  if (index + 1 === total) return "Last one.";
  if (index + 1 === Math.ceil(total / 2)) return "Halfway. Nice pace.";
  return `${index + 1} of ${total}`;
}
