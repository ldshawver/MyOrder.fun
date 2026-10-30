import { eq, sql } from "drizzle-orm";
import { adminSettingsTable, db } from "@workspace/db";
import type { NormalizedCartLine } from "./checkoutNormalizer";
import { safeDecrypt } from "./crypto";
import { quantityUnits } from "./exactQuantity";
import { inspectCheckoutInventoryAvailability } from "./inventoryReservations";
import { fetchWooSafely } from "./wooSafeHttp";

export type WooAvailabilityEntity = {
  id?: number | string;
  status?: string;
  purchasable?: boolean;
  stock_status?: string;
  manage_stock?: boolean;
  stock_quantity?: number | null;
  backorders?: string;
  backorders_allowed?: boolean;
};

export class CartItemUnavailableError extends Error {
  readonly status = 409;
  readonly code = "CART_ITEM_UNAVAILABLE";
  constructor(readonly catalogItemId: number, message = "This item is not currently available for purchase.") {
    super(message);
    this.name = "CartItemUnavailableError";
  }
}

export class WooAvailabilityProviderError extends Error {
  readonly status = 503;
  readonly code = "WOO_AVAILABILITY_UNAVAILABLE";
  constructor() {
    super("We couldn't verify this item's WooCommerce availability. Please try again.");
    this.name = "WooAvailabilityProviderError";
  }
}

function backordersAllowed(entity: WooAvailabilityEntity): boolean {
  return entity.backorders_allowed === true || entity.backorders === "yes" || entity.backorders === "notify";
}

/** Evaluate the same purchase signals Woo exposes to its own storefront. */
export function isWooEntityOrderable(entity: WooAvailabilityEntity, quantity: number): boolean {
  if (entity.purchasable !== true || !Number.isSafeInteger(quantity) || quantity <= 0) return false;
  if (entity.status != null && entity.status !== "publish") return false;
  if (backordersAllowed(entity)) return true;
  if (entity.stock_status !== "instock") return false;
  if (entity.manage_stock === true) {
    return typeof entity.stock_quantity === "number"
      && Number.isFinite(entity.stock_quantity)
      && entity.stock_quantity >= quantity;
  }
  return true;
}

export function isWooMappingOrderable(
  product: WooAvailabilityEntity,
  variation: WooAvailabilityEntity | null,
  quantity: number,
): boolean {
  return isWooEntityOrderable(product, quantity)
    && (variation == null || isWooEntityOrderable(variation, quantity));
}

type WooCredentials = { storeUrl: string; consumerKey: string; consumerSecret: string };

async function loadWooCredentials(tenantId: number): Promise<WooCredentials> {
  const [settings] = await db.select({
    storeUrl: adminSettingsTable.wcStoreUrl,
    consumerKey: adminSettingsTable.wcConsumerKey,
    consumerSecret: adminSettingsTable.wcConsumerSecret,
    enabled: adminSettingsTable.wcEnabled,
  }).from(adminSettingsTable).where(eq(adminSettingsTable.tenantId, tenantId)).limit(1);
  const consumerKey = safeDecrypt(settings?.consumerKey);
  const consumerSecret = safeDecrypt(settings?.consumerSecret);
  if (settings?.enabled === false || !settings?.storeUrl?.trim() || !consumerKey || !consumerSecret) {
    throw new WooAvailabilityProviderError();
  }
  return { storeUrl: settings.storeUrl.trim(), consumerKey, consumerSecret };
}

async function fetchWooEntity(credentials: WooCredentials, path: string, expectedId: string): Promise<WooAvailabilityEntity> {
  try {
    const response = await fetchWooSafely(credentials.storeUrl, path, credentials.consumerKey, credentials.consumerSecret);
    if (!response.ok) throw new Error(`WooCommerce returned ${response.status}`);
    const entity = await response.json() as WooAvailabilityEntity;
    if (!entity || String(entity.id) !== expectedId || typeof entity.purchasable !== "boolean" || typeof entity.stock_status !== "string") {
      throw new Error("WooCommerce returned an invalid availability response");
    }
    return entity;
  } catch {
    throw new WooAvailabilityProviderError();
  }
}

export async function requireWooMappingAvailable(
  tenantId: number,
  mapping: { catalogItemId: number; wooProductId: string; wooVariationId: string | null; quantity: number },
): Promise<void> {
  const credentials = await loadWooCredentials(tenantId);
  const productId = encodeURIComponent(mapping.wooProductId);
  const product = await fetchWooEntity(credentials, `/wp-json/wc/v3/products/${productId}`, mapping.wooProductId);
  let variation: WooAvailabilityEntity | null = null;
  if (mapping.wooVariationId) {
    const variationId = encodeURIComponent(mapping.wooVariationId);
    variation = await fetchWooEntity(credentials,
      `/wp-json/wc/v3/products/${productId}/variations/${variationId}`, mapping.wooVariationId);
  }
  if (!isWooMappingOrderable(product, variation, mapping.quantity)) throw new CartItemUnavailableError(mapping.catalogItemId);
}

type AvailabilityDependencies = {
  requireWoo: typeof requireWooMappingAvailable;
  inspectLocal: (tenantId: number, catalogItemId: number, quantity: number) => Promise<void>;
};

function rows<T>(result: unknown): T[] {
  return Array.isArray(result) ? result as T[] : ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

async function requireLocalInventoryAvailable(tenantId: number, catalogItemId: number, quantity: number): Promise<void> {
  const option = rows<{ inventoryCatalogItemId: number; consumptionQuantity: string }>(await db.execute(sql`
    SELECT ii.catalog_item_id AS "inventoryCatalogItemId", co.consumption_quantity AS "consumptionQuantity"
    FROM catalogue_options co
    JOIN catalogue_products cp ON cp.tenant_id = co.tenant_id AND cp.id = co.product_id
    JOIN inventory_items ii ON ii.tenant_id = co.tenant_id AND ii.id = co.inventory_item_id
    WHERE co.tenant_id = ${tenantId} AND co.catalog_item_id = ${catalogItemId}
      AND co.active = true AND cp.active = true
    LIMIT 1
  `))[0];
  if (!option) throw new CartItemUnavailableError(catalogItemId);
  const required = quantityUnits(option.consumptionQuantity) * BigInt(quantity);
  const availability = await inspectCheckoutInventoryAvailability(db, tenantId, option.inventoryCatalogItemId);
  const requiredQuantity = Number(required) / 1_000_000;
  if (!availability.hasInventoryRows || availability.available < requiredQuantity) {
    throw new CartItemUnavailableError(catalogItemId,
      availability.hasInventoryRows
        ? "This item does not have enough local inventory available."
        : "This locally managed item has no active sellable inventory balance.");
  }
}

const defaultDependencies: AvailabilityDependencies = {
  requireWoo: requireWooMappingAvailable,
  inspectLocal: requireLocalInventoryAvailable,
};

/** Woo-managed lines never consult MyOrder's ledger. */
export async function requireCartLinesAvailable(
  lines: NormalizedCartLine[],
  tenantId: number,
  options: { includeLocal: boolean } = { includeLocal: true },
  dependencies: AvailabilityDependencies = defaultDependencies,
): Promise<void> {
  const wooMappings = new Map<string, { catalogItemId: number; wooProductId: string; wooVariationId: string | null; quantity: number }>();
  for (const line of lines) {
    if (line.source_type === "woo") {
      if (!line.woo_product_id) throw new CartItemUnavailableError(line.catalog_item_id);
      const key = `${line.woo_product_id}:${line.woo_variation_id ?? ""}`;
      const existing = wooMappings.get(key);
      if (existing) existing.quantity += line.quantity;
      else wooMappings.set(key, { catalogItemId: line.catalog_item_id, wooProductId: line.woo_product_id,
        wooVariationId: line.woo_variation_id, quantity: line.quantity });
    } else if (options.includeLocal) {
      await dependencies.inspectLocal(tenantId, line.catalog_item_id, line.quantity);
    }
  }
  for (const mapping of wooMappings.values()) await dependencies.requireWoo(tenantId, mapping);
}
