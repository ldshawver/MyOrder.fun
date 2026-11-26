import { isCatalogItemForSale } from "./catalogEligibility";
import { resolveEffectiveCatalogUnitPrice } from "./checkoutNormalizer";

export const SPEED_ORDER_SLOT_COUNT = 9;
export const SPEED_ORDER_RANK_WINDOW_DAYS = 30;
/** Stored under tenants.settings so no new table or migration is required. */
export const SPEED_ORDER_PINS_KEY = "speedOrderPins";

export type SpeedOrderPin = { slot: number; catalogItemId: number };
export type RankedSale = { catalogItemId: number; units: number };
export type SpeedOrderCatalogItem = { id: number; name: string; price: number; imageUrl: string | null };
export type SpeedOrderSlot = {
  slot: number;
  source: "pin" | "rank" | "empty";
  catalogItemId: number | null;
  units: number;
  name: string | null;
  price: number | null;
  imageUrl: string | null;
};

type SellableSource = {
  id: number; name: string; displayName?: string | null; alavontName?: string | null;
  imageUrl?: string | null; displayImage?: string | null; alavontImageUrl?: string | null;
  price: string | number; regularPrice?: string | number | null; compareAtPrice?: string | number | null;
  metadata?: unknown; isAvailable: boolean;
};

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function parseSpeedOrderPins(value: unknown): SpeedOrderPin[] {
  if (!Array.isArray(value)) return [];
  const seenSlots = new Set<number>();
  const seenItems = new Set<number>();
  const pins: SpeedOrderPin[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const { slot, catalogItemId } = raw as { slot?: unknown; catalogItemId?: unknown };
    const id = positiveInteger(catalogItemId);
    if (!Number.isSafeInteger(slot) || (slot as number) < 0 || (slot as number) >= SPEED_ORDER_SLOT_COUNT || !id) continue;
    if (seenSlots.has(slot as number) || seenItems.has(id)) continue;
    seenSlots.add(slot as number); seenItems.add(id); pins.push({ slot: slot as number, catalogItemId: id });
  }
  return pins;
}

export function acceptSpeedOrderPins(value: unknown): { ok: true; pins: SpeedOrderPin[] } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as { pins?: unknown }).pins)) return { ok: false, error: "Pins must be a list" };
  const raw = (value as { pins: unknown[] }).pins;
  if (raw.length > SPEED_ORDER_SLOT_COUNT) return { ok: false, error: "At most nine pins are allowed" };
  const pins = parseSpeedOrderPins(raw);
  return pins.length === raw.length ? { ok: true, pins } : { ok: false, error: "Pins must use unique slots and eligible catalog item IDs" };
}

export function speedOrderSellableItem(row: SellableSource): SpeedOrderCatalogItem | null {
  if (!isCatalogItemForSale(row)) return null;
  try {
    const price = resolveEffectiveCatalogUnitPrice(row);
    if (!Number.isFinite(price) || price < 0) return null;
    return {
      id: row.id,
      name: row.displayName?.trim() || row.alavontName?.trim() || row.name,
      price,
      imageUrl: row.displayImage?.trim() || row.alavontImageUrl?.trim() || row.imageUrl?.trim() || null,
    };
  } catch { return null; }
}

export function selectHybridTopNine(input: { ranked: RankedSale[]; pins: SpeedOrderPin[]; catalog: SpeedOrderCatalogItem[] }): SpeedOrderSlot[] {
  const catalog = new Map(input.catalog.map(item => [item.id, item]));
  const units = new Map<number, number>();
  for (const row of input.ranked) if (positiveInteger(row.catalogItemId) && Number.isFinite(row.units) && row.units > 0) units.set(row.catalogItemId, Math.max(units.get(row.catalogItemId) ?? 0, row.units));
  const used = new Set<number>();
  const pinsBySlot = new Map<number, SpeedOrderPin>();
  for (const pin of parseSpeedOrderPins(input.pins)) if (catalog.has(pin.catalogItemId) && !used.has(pin.catalogItemId)) { pinsBySlot.set(pin.slot, pin); used.add(pin.catalogItemId); }
  const automatic = [...units.entries()]
    .filter(([id]) => catalog.has(id) && !used.has(id))
    .sort(([leftId, leftUnits], [rightId, rightUnits]) => rightUnits - leftUnits || leftId - rightId);
  let next = 0;
  return Array.from({ length: SPEED_ORDER_SLOT_COUNT }, (_, slot): SpeedOrderSlot => {
    const selected = pinsBySlot.get(slot) ?? (automatic[next] ? { slot, catalogItemId: automatic[next++]![0] } : undefined);
    const item = selected ? catalog.get(selected.catalogItemId) : undefined;
    if (!item) return { slot, source: "empty", catalogItemId: null, units: 0, name: null, price: null, imageUrl: null };
    return { slot, source: pinsBySlot.has(slot) ? "pin" : "rank", catalogItemId: item.id, units: units.get(item.id) ?? 0, name: item.name, price: item.price, imageUrl: item.imageUrl };
  });
}
