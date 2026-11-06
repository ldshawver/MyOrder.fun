import { recommendReplenishment } from "./cataloguePolicy";
import { ledgerQuantityUnits, quantityText, quantityUnits } from "./exactQuantity";

export const BUSINESS_TIME_ZONE = "America/Los_Angeles";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export type ClockPoint = { orders: number; revenue: number };
export type HourPoint = ClockPoint & { hour: number; label: string };
export type WeekdayPoint = ClockPoint & { day: string };

export type StockLocationRow = {
  inventoryItemId: number;
  productName: string;
  optionLabel: string;
  locationId: number;
  locationName: string;
  onHand: string;
  available: string;
  par: string;
  reorderPoint: string;
  preferredReorderQuantity: string;
  moq: string;
  eligible: boolean;
};

export type InventoryProduct = { name: string; onHand: string; available: string; locations: number };
export type SuggestedLine = {
  product: string;
  location: string;
  available: string;
  par: string;
  reorderPoint: string;
  transfer: string;
  orderQuantity: string;
};

export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h < 12 ? "AM" : "PM";
  const clock = h % 12 === 0 ? 12 : h % 12;
  return `${clock} ${suffix}`;
}

function zonePart(date: Date, type: "hour" | "weekday", timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date).find((part) => part.type === type)?.value ?? "";
}

export function hourInBusinessZone(date: Date, timeZone = BUSINESS_TIME_ZONE): number {
  const raw = Number(zonePart(date, "hour", timeZone));
  if (!Number.isInteger(raw)) return 0;
  return raw === 24 ? 0 : Math.min(23, Math.max(0, raw));
}

export function weekdayInBusinessZone(date: Date, timeZone = BUSINESS_TIME_ZONE): number {
  const index = WEEKDAYS.indexOf(zonePart(date, "weekday", timeZone) as (typeof WEEKDAYS)[number]);
  return index >= 0 ? index : 0;
}

export function emptyHours(): HourPoint[] {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, label: hourLabel(hour), orders: 0, revenue: 0 }));
}

export function emptyWeekdays(): WeekdayPoint[] {
  return WEEKDAYS.map((day) => ({ day, orders: 0, revenue: 0 }));
}

export function optionTitle(productName: string, optionLabel: string | null | undefined): string {
  const name = productName.trim() || "Item";
  const label = optionLabel?.trim() || "Standard";
  return label === "Standard" ? name : `${name} — ${label}`;
}

function units(value: string): bigint {
  try { return quantityUnits(value); } catch { return 0n; }
}

export function inventoryRollup(rows: StockLocationRow[]): InventoryProduct[] {
  const grouped = new Map<number, { name: string; onHand: bigint; available: bigint; locations: number }>();
  for (const row of rows) {
    if (!row.eligible) continue;
    const current = grouped.get(row.inventoryItemId) ?? {
      name: optionTitle(row.productName, row.optionLabel),
      onHand: 0n,
      available: 0n,
      locations: 0,
    };
    try { current.onHand += ledgerQuantityUnits(row.onHand); } catch { /* skip a malformed count */ }
    current.available += units(row.available);
    current.locations += 1;
    grouped.set(row.inventoryItemId, current);
  }
  return [...grouped.values()]
    .map((row) => ({ name: row.name, onHand: quantityText(row.onHand), available: quantityText(row.available), locations: row.locations }))
    .sort((a, b) => (units(a.available) < units(b.available) ? 1 : -1));
}

export function suggestedOrderLines(rows: StockLocationRow[]): SuggestedLine[] {
  const grouped = new Map<number, StockLocationRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.inventoryItemId) ?? [];
    list.push(row);
    grouped.set(row.inventoryItemId, list);
  }
  const lines: SuggestedLine[] = [];
  for (const group of grouped.values()) {
    const names = new Map(group.map((row) => [row.locationId, row.locationName]));
    const title = optionTitle(group[0]!.productName, group[0]!.optionLabel);
    const recommendations = recommendReplenishment(group.map((row) => ({
      locationId: row.locationId,
      name: row.locationName,
      available: row.available,
      par: row.par,
      reorderPoint: row.reorderPoint,
      preferredReorderQuantity: row.preferredReorderQuantity,
      moq: row.moq,
      eligible: row.eligible,
    })));
    for (const recommendation of recommendations) {
      if (units(recommendation.externalPurchaseQuantity) <= 0n && recommendation.internalTransfers.length === 0) continue;
      const source = group.find((row) => row.locationId === recommendation.locationId);
      lines.push({
        product: title,
        location: recommendation.locationName,
        available: recommendation.available,
        par: source?.par ?? "0.000000",
        reorderPoint: source?.reorderPoint ?? "0.000000",
        transfer: recommendation.internalTransfers
          .map((transfer) => `${transfer.quantity} from ${names.get(transfer.fromLocationId) ?? "another location"}`)
          .join("; "),
        orderQuantity: recommendation.externalPurchaseQuantity,
      });
    }
  }
  return lines.sort((a, b) => (units(a.orderQuantity) < units(b.orderQuantity) ? 1 : -1));
}
