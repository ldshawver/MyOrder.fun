import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, catalogItemsTable, inventoryLocationsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved } from "../lib/auth";
import { requirePermission, isGlobalAdmin } from "../lib/roles";
import { requireTenantContext } from "../lib/tenantContext";
import { getOrCreateSettings, getDecryptedWooCreds } from "./settings";
import { wooVariationLabel, wooVariationMetadata, wooVariationOptionValues } from "../lib/wooVariants";
import { mapWooSellingPrice } from "../lib/wooPricing";
import { getTenantSettings } from "../config/tenantConfig";
import { enqueueWooSync, getTenantWooSyncJob } from "../lib/wooSyncJobs";
import { postImportedInventoryBalanceCorrection } from "../lib/inventoryMovementLedger";
import { z } from "zod";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireTenantContext);

function requireTenantAssignedOrGlobal(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): void {
  const actor = req.dbUser!;
  if (isGlobalAdmin(actor) || actor.tenantId != null) return next();
  res.status(403).json({ error: "Tenant-scoped WooCommerce access requires a tenant assignment" });
}


let wooCatalogSchemaEnsured = false;

async function ensureWooCatalogSchema(): Promise<void> {
  if (wooCatalogSchemaEnsured) return;
  const statements = [
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "media_gallery" jsonb DEFAULT '[]'::jsonb`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "regular_price" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "homie_price" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_id" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_image_url" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_in_stock" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_is_upsell" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_is_sample" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_created_date" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_updated_date" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_image_url" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_description" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "receipt_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "label_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lab_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_woo_managed" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_local_alavont" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_processing_mode" text DEFAULT 'mapped_lucifer'`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_product_source" text DEFAULT 'local_mapped'`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_brand" text NOT NULL DEFAULT 'alavont'`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_sku" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "woo_product_id" text`,
  ];
  for (const statement of statements) {
    await db.execute(statement);
  }
  wooCatalogSchemaEnsured = true;
}

interface WooProduct {
  id?: number | string;
  name?: string;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  categories?: Array<{ name?: string }>;
  images?: Array<{ src?: string }>;
  description?: string;
  short_description?: string;
  stock_status?: string;
  manage_stock?: boolean;
  stock_quantity?: number | null;
  status?: string;
  catalog_visibility?: string;
  sku?: string;
  type?: string;
  date_created?: string | null;
  date_modified?: string | null;
}

interface WooVariation {
  id?: number | string;
  sku?: string;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  stock_status?: string;
  manage_stock?: boolean;
  stock_quantity?: number | null;
  status?: string;
  attributes?: Array<{ name?: string; option?: string }>;
  image?: { src?: string };
  meta_data?: Array<{ key?: string; value?: unknown }>;
}

type WooFailureKind = "authentication" | "configuration" | "unavailable" | "timeout" | "malformed";

export class WooCommerceUpstreamError extends Error {
  constructor(
    readonly kind: WooFailureKind,
    readonly upstreamStatus: number | null = null,
  ) {
    super(kind);
  }
}

function classifyWooStatus(status: number): WooCommerceUpstreamError {
  if (status === 401 || status === 403) return new WooCommerceUpstreamError("authentication", status);
  if (status === 404) return new WooCommerceUpstreamError("configuration", status);
  return new WooCommerceUpstreamError("unavailable", status);
}

export function wooFailureResponse(error: unknown): { status: number; body: { ok: false; code: string; message: string; upstreamStatus: number | null } } {
  const failure = error instanceof WooCommerceUpstreamError
    ? error
    : new WooCommerceUpstreamError("unavailable");
  const messages: Record<WooFailureKind, { status: number; code: string; message: string }> = {
    authentication: { status: 424, code: "woocommerce_auth_failed", message: "WooCommerce rejected the saved credentials." },
    configuration: { status: 422, code: "woocommerce_endpoint_not_found", message: "The configured WooCommerce API endpoint was not found." },
    unavailable: { status: 503, code: "woocommerce_unavailable", message: "WooCommerce is temporarily unavailable." },
    timeout: { status: 504, code: "woocommerce_timeout", message: "WooCommerce did not respond before the request timed out." },
    malformed: { status: 502, code: "woocommerce_malformed_response", message: "WooCommerce returned an invalid response." },
  };
  const mapped = messages[failure.kind];
  return { status: mapped.status, body: { ok: false, code: mapped.code, message: mapped.message, upstreamStatus: failure.upstreamStatus } };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return stripHtml(value);
}

export function pickWooCategory(categories: Array<{ name?: string }> | undefined): string {
  const names = (categories ?? [])
    .map((cat) => decodeHtmlEntities(cat.name?.trim() || ""))
    .filter(Boolean);
  // Woo commonly returns ancestor categories before their children; preserve
  // the most specific actual category without a merchant-specific allowlist.
  return names.at(-1) || "Uncategorized";
}

import { fetchWooSafely } from "../lib/wooSafeHttp";
const WOO_MAX_PAGES = 100;

async function fetchWoo(storeUrl: string, path: string, consumerKey: string, consumerSecret: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchWooSafely(storeUrl, path, consumerKey, consumerSecret);
      if (response.ok) return response;
      const failure = classifyWooStatus(response.status);
      lastError = failure;
      if (response.status !== 429 && response.status < 500) throw failure;
      const retryAfter = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(10_000, retryAfter * 1000) : 500 * 2 ** attempt;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, delay));
    } catch (error) {
      if (error instanceof WooCommerceUpstreamError && error.upstreamStatus !== null && error.upstreamStatus < 500 && error.upstreamStatus !== 429) throw error;
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  if (lastError instanceof Error && /timed out/i.test(lastError.message)) throw new WooCommerceUpstreamError("timeout");
  if (lastError instanceof WooCommerceUpstreamError) throw lastError;
  throw new WooCommerceUpstreamError("unavailable");
}

async function getWooCurrency(storeUrl: string, consumerKey: string, consumerSecret: string, tenantId: number): Promise<string> {
  const response = await fetchWoo(storeUrl.replace(/\/$/, ""), "/wp-json/wc/v3/system_status", consumerKey, consumerSecret);
  const data = await response.json().catch(() => { throw new WooCommerceUpstreamError("malformed"); }) as { environment?: { currency_code?: unknown } };
  const currency = typeof data?.environment?.currency_code === "string" ? data.environment.currency_code.toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) throw new WooCommerceUpstreamError("malformed");
  const tenant = await getTenantSettings(tenantId);
  if (!tenant || tenant.business.defaultCurrency.toUpperCase() !== currency) throw new Error("woo_currency_mismatch");
  return currency;
}

async function fetchAllWooProducts(storeUrl: string, consumerKey: string, consumerSecret: string) {
  const base = storeUrl.replace(/\/$/, "");
  const allProducts: WooProduct[] = [];
  let page = 1;
  // A full page from this store exceeds the safe client's 10-second timeout.
  const perPage = 20;

  while (page <= WOO_MAX_PAGES) {
    const res = await fetchWoo(base, `/wp-json/wc/v3/products?per_page=${perPage}&page=${page}&status=publish`, consumerKey, consumerSecret);
    const products = await res.json().catch(() => { throw new WooCommerceUpstreamError("malformed"); }) as WooProduct[];
    if (!Array.isArray(products)) throw new WooCommerceUpstreamError("malformed");
    if (products.length === 0) break;
    allProducts.push(...products);

    // Check total pages from header
    const totalPagesHeader = res.headers.get("X-WP-TotalPages");
    const totalPages = totalPagesHeader === null ? null : Number(totalPagesHeader);
    if (totalPages !== null && (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > WOO_MAX_PAGES)) {
      throw new WooCommerceUpstreamError("malformed");
    }
    if ((totalPages !== null && page >= totalPages) || products.length < perPage) break;
    if (page === WOO_MAX_PAGES) throw new WooCommerceUpstreamError("malformed");
    page++;
  }

  return allProducts;
}

async function fetchWooProduct(storeUrl: string, productId: string, consumerKey: string, consumerSecret: string): Promise<WooProduct> {
  const response = await fetchWoo(storeUrl.replace(/\/$/, ""), `/wp-json/wc/v3/products/${encodeURIComponent(productId)}`, consumerKey, consumerSecret);
  const product = await response.json().catch(() => { throw new WooCommerceUpstreamError("malformed"); }) as WooProduct;
  if (!product || String(product.id) !== productId || !product.name) throw new WooCommerceUpstreamError("malformed");
  return product;
}

async function fetchWooVariations(storeUrl: string, productId: string, consumerKey: string, consumerSecret: string): Promise<WooVariation[]> {
  const all: WooVariation[] = [];
  for (let page = 1; page <= WOO_MAX_PAGES; page++) {
    const response = await fetchWoo(storeUrl.replace(/\/$/, ""), `/wp-json/wc/v3/products/${encodeURIComponent(productId)}/variations?per_page=100&page=${page}`, consumerKey, consumerSecret);
    const values = await response.json().catch(() => { throw new WooCommerceUpstreamError("malformed"); }) as WooVariation[];
    if (!Array.isArray(values)) throw new WooCommerceUpstreamError("malformed");
    all.push(...values);
    const pages = Number(response.headers.get("X-WP-TotalPages") ?? "1");
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > WOO_MAX_PAGES) throw new WooCommerceUpstreamError("malformed");
    if (page >= pages || values.length === 0) return all;
  }
  throw new WooCommerceUpstreamError("malformed");
}

function queryRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

async function syncWooProductVariants(input: {
  executor: Pick<typeof db, "select" | "update" | "insert" | "execute">;
  tenantId: number; parentProductId: number; parentCatalogItemId: number; wooProductId: string;
  product: WooProduct; variations: WooVariation[]; currency: string;
}): Promise<{ created: number; updated: number; skipped: number }> {
  const { executor, tenantId, parentProductId, parentCatalogItemId, wooProductId, product, variations, currency } = input;
  let createdCount = 0, updatedCount = 0, skippedCount = 0;
  const parent = await executor.select().from(catalogItemsTable)
    .where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, parentCatalogItemId))).limit(1);
  if (!parent[0]) throw new Error("Woo variable parent is not tenant-owned");
  const parentMetadata = parent[0].metadata && typeof parent[0].metadata === "object" && !Array.isArray(parent[0].metadata)
    ? parent[0].metadata as Record<string, unknown> : {};
  await executor.execute(sql`UPDATE catalogue_options SET active = false WHERE tenant_id = ${tenantId}
    AND product_id = ${parentProductId} AND catalog_item_id = ${parentCatalogItemId}`);
  const seen = new Set<string>();
  for (const variation of variations) {
    if (!variation.id) { skippedCount++; continue; }
    const variationId = String(variation.id);
    seen.add(variationId);
    const values = wooVariationOptionValues(variation.attributes, variationId);
    const label = wooVariationLabel(values);
    const mappedPrice = mapWooSellingPrice({ price: variation.price, regularPrice: variation.regular_price, salePrice: variation.sale_price, currency });
    const imageUrl = variation.image?.src?.trim() || parent[0].imageUrl;
    const barcodeMeta = variation.meta_data?.find(meta => ["barcode", "gtin", "ean", "upc"].includes((meta.key ?? "").toLowerCase()));
    const barcode = typeof barcodeMeta?.value === "string" ? barcodeMeta.value.trim() || null : null;
    const isAvailable = variation.status !== "private" && variation.status !== "draft" && (variation.stock_status ? variation.stock_status === "instock" : true);
    const existing = queryRows<{ id: number; metadata: unknown }>(await executor.execute(sql`SELECT id, metadata FROM catalog_items
      WHERE tenant_id = ${tenantId} AND woo_product_id = ${wooProductId} AND woo_variation_id = ${variationId} LIMIT 1`))[0];
    let catalogItemId = existing?.id;
    if (!catalogItemId) {
      const created = await executor.insert(catalogItemsTable).values({
        tenantId, name: `${product.name ?? parent[0].name} — ${label}`, description: parent[0].description,
        category: parent[0].category, price: mappedPrice.price, compareAtPrice: mappedPrice.compareAtPrice, sku: variation.sku?.trim() || null, barcode,
        isAvailable, isTaxable: parent[0].isTaxable, stockQuantity: "0", imageUrl,
        metadata: wooVariationMetadata(parentMetadata, null, parentCatalogItemId),
        alavontName: `${product.name ?? parent[0].name} — ${label}`, luciferCruzName: `${product.name ?? parent[0].name} — ${label}`,
        customerSafeName: `${product.name ?? parent[0].name} — ${label}`, merchantName: `${product.name ?? parent[0].name} — ${label}`,
        merchantBrand: parent[0].merchantBrand, merchantSku: variation.sku?.trim() || null,
        isWooManaged: true, isLocalAlavont: false, merchantProcessingMode: "woo_native", merchantProductSource: "woo",
        wooProductId, wooVariationId: variationId,
      }).returning({ id: catalogItemsTable.id });
      catalogItemId = created[0]?.id;
      createdCount++;
    } else {
      const currentMetadata = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
        ? existing.metadata as Record<string, unknown> : {};
      const variantMetadata = { ...wooVariationMetadata(parentMetadata, currentMetadata, parentCatalogItemId),
        isVisible: parentMetadata.isVisible !== false };
      await executor.update(catalogItemsTable).set({
        name: `${product.name ?? parent[0].name} — ${label}`, price: mappedPrice.price, compareAtPrice: mappedPrice.compareAtPrice,
        sku: variation.sku?.trim() || null, barcode, isAvailable, imageUrl,
        metadata: variantMetadata, updatedAt: new Date(),
      }).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, catalogItemId)));
      updatedCount++;
    }
    if (!catalogItemId) throw new Error("Woo variation insert did not return an identity");
    await executor.execute(sql`INSERT INTO woocommerce_stock_snapshots (
      tenant_id,catalog_item_id,woo_product_id,woo_variation_id,stock_management,managed_stock,stock_quantity,stock_status,currency_code,observed_at
    ) VALUES (${tenantId},${catalogItemId},${wooProductId},${variationId},
      ${variation.manage_stock ? "variation" : product.manage_stock ? "shared_parent" : "unmanaged"},
      ${variation.manage_stock === true},${variation.manage_stock && variation.stock_quantity != null ? String(variation.stock_quantity) : null},
      ${variation.stock_status ?? null},${currency},now())
    ON CONFLICT (tenant_id,woo_product_id,woo_variation_id) WHERE woo_variation_id IS NOT NULL
    DO UPDATE SET catalog_item_id=EXCLUDED.catalog_item_id,stock_management=EXCLUDED.stock_management,
      managed_stock=EXCLUDED.managed_stock,stock_quantity=EXCLUDED.stock_quantity,stock_status=EXCLUDED.stock_status,
      currency_code=EXCLUDED.currency_code,observed_at=now()`);
    // Caller provides a transaction executor; these updates participate in
    // the same atomic parent+variation write as the catalogue upsert.
    {
      const tx = executor;
      const own = queryRows<{ optionId: number; generatedProductId: number }>(await tx.execute(sql`SELECT id AS "optionId", product_id AS "generatedProductId"
        FROM catalogue_options WHERE tenant_id = ${tenantId} AND catalog_item_id = ${catalogItemId} LIMIT 1`))[0];
      if (!own) throw new Error("Woo variation inventory identity was not created");
      await tx.execute(sql`UPDATE catalogue_options SET product_id = ${parentProductId}, label = ${label},
        option_values = ${JSON.stringify(values)}::jsonb, active = true, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${own.optionId}`);
      if (own.generatedProductId !== parentProductId) await tx.execute(sql`DELETE FROM catalogue_products
        WHERE tenant_id = ${tenantId} AND id = ${own.generatedProductId}`);
    }
  }
  const previous = queryRows<{ id: number; wooVariationId: string }>(await executor.execute(sql`SELECT ci.id, ci.woo_variation_id AS "wooVariationId"
    FROM catalog_items ci JOIN catalogue_options co ON co.tenant_id = ci.tenant_id AND co.catalog_item_id = ci.id
    WHERE ci.tenant_id = ${tenantId} AND ci.woo_product_id = ${wooProductId} AND ci.woo_variation_id IS NOT NULL
      AND co.product_id = ${parentProductId}`));
  for (const old of previous) if (!seen.has(old.wooVariationId)) {
    await executor.execute(sql`UPDATE catalogue_options SET active = false, updated_at = now()
      WHERE tenant_id = ${tenantId} AND product_id = ${parentProductId} AND catalog_item_id = ${old.id}`);
    await executor.execute(sql`UPDATE catalog_items SET is_available = false, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${old.id}`);
    updatedCount++;
  }
  return { created: createdCount, updated: updatedCount, skipped: skippedCount };
}

type WooImportSummary = { parentsCreated: number; parentsUpdated: number; variantsCreated: number; variantsUpdated: number; skipped: number; failed: number; totalParents: number; totalVariants: number; errors: Array<{ productId: string; code: string }> };
type WooProgress = (summary: WooImportSummary) => Promise<void>;

function wooErrorCode(error: unknown): string {
  if (error instanceof WooCommerceUpstreamError) return `upstream_${error.kind}`;
  if (error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)) return error.message;
  return "product_import_failed";
}

async function upsertStockSnapshot(executor: Pick<typeof db, "execute">, input: {
  tenantId: number; itemId: number; productId: string; variationId: string | null; management: "independent" | "variation" | "shared_parent" | "unmanaged";
  managed: boolean; quantity: number | null; status: string | null; currency: string;
}): Promise<void> {
  const quantity = input.managed && input.quantity != null && Number.isFinite(input.quantity) && input.quantity >= 0 ? String(input.quantity) : null;
  if (input.variationId === null) {
    await executor.execute(sql`INSERT INTO woocommerce_stock_snapshots
      (tenant_id,catalog_item_id,woo_product_id,woo_variation_id,stock_management,managed_stock,stock_quantity,stock_status,currency_code,observed_at)
      VALUES (${input.tenantId},${input.itemId},${input.productId},NULL,${input.management},${input.managed},${quantity},${input.status},${input.currency},now())
      ON CONFLICT (tenant_id,woo_product_id) WHERE woo_variation_id IS NULL
        DO UPDATE SET catalog_item_id=EXCLUDED.catalog_item_id,stock_management=EXCLUDED.stock_management,
          managed_stock=EXCLUDED.managed_stock,stock_quantity=EXCLUDED.stock_quantity,stock_status=EXCLUDED.stock_status,
          currency_code=EXCLUDED.currency_code,observed_at=now()`);
  } else {
    await executor.execute(sql`INSERT INTO woocommerce_stock_snapshots
      (tenant_id,catalog_item_id,woo_product_id,woo_variation_id,stock_management,managed_stock,stock_quantity,stock_status,currency_code,observed_at)
      VALUES (${input.tenantId},${input.itemId},${input.productId},${input.variationId},${input.management},${input.managed},${quantity},${input.status},${input.currency},now())
      ON CONFLICT (tenant_id,woo_product_id,woo_variation_id) WHERE woo_variation_id IS NOT NULL
        DO UPDATE SET catalog_item_id=EXCLUDED.catalog_item_id,stock_management=EXCLUDED.stock_management,
          managed_stock=EXCLUDED.managed_stock,stock_quantity=EXCLUDED.stock_quantity,stock_status=EXCLUDED.stock_status,
          currency_code=EXCLUDED.currency_code,observed_at=now()`);
  }
}

/** One parent and all its variations commit atomically; network calls finish before this transaction starts. */
async function importWooProduct(tenantId: number, product: WooProduct, variations: WooVariation[] | null, currency: string): Promise<{ parent: "created" | "updated" | "skipped"; variants: { created: number; updated: number; skipped: number } }> {
  const wcId = String(product.id);
  const name = product.name?.trim() ?? "";
  if (!name) throw new Error("woo_product_name_missing");
  const variationPrices = (variations ?? []).map(v => mapWooSellingPrice({ price: v.price, regularPrice: v.regular_price, salePrice: v.sale_price, currency }).price);
  const fallbackCurrent = product.price || (variationPrices.length ? variationPrices.sort((a, b) => Number(a) - Number(b))[0] : null);
  const priceMap = mapWooSellingPrice({ price: fallbackCurrent, regularPrice: product.regular_price, salePrice: product.sale_price, currency });
  const category = pickWooCategory(product.categories);
  const imageUrls = (product.images ?? []).map(image => image.src?.trim() || "").filter(Boolean);
  const imageUrl = imageUrls[0] || null;
  const mediaGallery = imageUrls.map(src => ({ type: "image" as const, src, alt: name }));
  const description = product.description ? stripHtml(product.description) : null;
  const shortDesc = product.short_description ? stripHtml(product.short_description) : null;
  const inStock = product.stock_status ? product.stock_status === "instock" : false;
  const visibleInCatalog = product.catalog_visibility !== "hidden" && product.catalog_visibility !== "search";
  const wcSku = product.sku?.trim() || null;
  const result = await db.transaction(async tx => {
    // Woo IDs are provider-sized integers and may exceed PostgreSQL int4.
    // Hash the tenant + external ID into the bigint advisory-lock namespace.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${wcId}`}, 0))`);
    const matches = queryRows<{ id: number; isLocalAlavont: boolean; metadata: unknown }>(await tx.execute(sql`SELECT id, is_local_alavont AS "isLocalAlavont", metadata FROM catalog_items
      WHERE tenant_id=${tenantId} AND ((woo_product_id=${wcId} AND woo_variation_id IS NULL) OR alavont_id=${`wc_${wcId}`}) ORDER BY id LIMIT 2`));
    if (matches.length > 1) throw new Error("duplicate_woo_parent_identity");
    const existing = matches[0];
    if (existing?.isLocalAlavont) return { parent: "skipped" as const, parentId: existing.id, variants: { created: 0, updated: 0, skipped: 0 } };
    const values = {
      tenantId, name, description: shortDesc || description || null, category,
      price: priceMap.price, compareAtPrice: priceMap.compareAtPrice,
      isAvailable: product.type === "variable" ? false : inStock && product.status !== "draft" && product.status !== "private",
      sku: wcSku, imageUrl, mediaGallery,
      regularPrice: priceMap.compareAtPrice ?? priceMap.price, homiePrice: null,
      alavontId: `wc_${wcId}`, alavontName: name, alavontCategory: category, alavontImageUrl: imageUrl,
      alavontInStock: inStock, alavontIsUpsell: false, alavontIsSample: false,
      alavontCreatedDate: product.date_created ?? null, alavontUpdatedDate: product.date_modified ?? null,
      luciferCruzName: name, luciferCruzImageUrl: imageUrl, luciferCruzDescription: description, luciferCruzCategory: category,
      receiptName: name, labelName: name, labName: name,
      isWooManaged: true, isLocalAlavont: false, merchantProcessingMode: "woo_native", merchantProductSource: "woo",
      merchantBrand: "lucifer_cruz", merchantSku: wcSku, wooProductId: wcId,
    };
    let parentId = existing?.id;
    if (existing) {
      const metadata = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata) ? existing.metadata as Record<string, unknown> : {};
      await tx.update(catalogItemsTable).set({ ...values, metadata: { ...metadata, isVisible: visibleInCatalog } })
        .where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, existing.id)));
    } else {
      const [created] = await tx.insert(catalogItemsTable).values({ ...values, metadata: { isVisible: visibleInCatalog } }).returning({ id: catalogItemsTable.id });
      parentId = created?.id;
    }
    if (!parentId) throw new Error("woo_parent_identity_missing");
    await upsertStockSnapshot(tx, { tenantId, itemId: parentId, productId: wcId, variationId: null,
      management: product.type === "variable" && product.manage_stock ? "shared_parent" : product.manage_stock ? "independent" : "unmanaged",
      managed: product.manage_stock === true, quantity: product.stock_quantity ?? null, status: product.stock_status ?? null, currency });
    let variants = { created: 0, updated: 0, skipped: 0 };
    if (variations) {
      const catalogue = queryRows<{ productId: number }>(await tx.execute(sql`SELECT product_id AS "productId" FROM catalogue_options
        WHERE tenant_id=${tenantId} AND catalog_item_id=${parentId} LIMIT 1`))[0];
      if (!catalogue) throw new Error("woo_variable_parent_mapping_missing");
      variants = await syncWooProductVariants({ executor: tx, tenantId, parentProductId: catalogue.productId,
        parentCatalogItemId: parentId, wooProductId: wcId, product, variations, currency });
    }
    return { parent: existing ? "updated" as const : "created" as const, parentId, variants };
  });
  return { parent: result.parent, variants: result.variants };
}

export async function runWooCatalogSync(tenantId: number, onProgress?: WooProgress, targetWooProductId?: string): Promise<WooImportSummary> {
  await ensureWooCatalogSchema();
  const saved = await getDecryptedWooCreds(tenantId);
  const storeUrl = saved.storeUrl.trim();
  if (!saved.enabled) throw new Error("woo_sync_disabled");
  if (!storeUrl || !saved.consumerKey || !saved.consumerSecret) throw new Error("woo_saved_configuration_missing");
  const currency = await getWooCurrency(storeUrl, saved.consumerKey, saved.consumerSecret, tenantId);
  const products = targetWooProductId
    ? [await fetchWooProduct(storeUrl, targetWooProductId, saved.consumerKey, saved.consumerSecret)]
    : await fetchAllWooProducts(storeUrl, saved.consumerKey, saved.consumerSecret);
  const summary: WooImportSummary = { parentsCreated: 0, parentsUpdated: 0, variantsCreated: 0, variantsUpdated: 0,
    skipped: 0, failed: 0, totalParents: products.length, totalVariants: 0, errors: [] };
  await onProgress?.(summary);
  for (const product of products) {
    if (!product.id || !product.name) { summary.skipped++; summary.failed++; continue; }
    const wcId = String(product.id);
    try {
      // No database transaction remains open during provider calls.
      const variations = product.type === "variable" ? await fetchWooVariations(storeUrl, wcId, saved.consumerKey, saved.consumerSecret) : null;
      summary.totalVariants += variations?.length ?? 0;
      await onProgress?.(summary);
      const result = await importWooProduct(tenantId, product, variations, currency);
      if (result.parent === "created") summary.parentsCreated++;
      else if (result.parent === "updated") summary.parentsUpdated++;
      else summary.skipped++;
      summary.variantsCreated += result.variants.created;
      summary.variantsUpdated += result.variants.updated;
      summary.skipped += result.variants.skipped;
    } catch (error) {
      summary.failed++;
      summary.errors = [...summary.errors, { productId: wcId, code: wooErrorCode(error) }].slice(-20);
    }
    await onProgress?.(summary);
  }
  return summary;
}

// Kept synchronous only for bounded, single-product verified webhook reconciliation.
export async function syncHandler(req: import("express").Request, res: import("express").Response, targetWooProductId?: string): Promise<void> {
  try {
    const summary = await runWooCatalogSync(req.authorizedTenantId!, undefined, targetWooProductId);
    res.json({ inserted: summary.parentsCreated, updated: summary.parentsUpdated + summary.variantsUpdated,
      skipped: summary.skipped, failed: summary.failed, errors: summary.errors, total: summary.totalParents });
  } catch (err) {
    if (err instanceof Error && err.message === "woo_saved_configuration_missing") {
      res.status(412).json({ error: "Saved WooCommerce configuration is incomplete." }); return;
    }
    const failure = wooFailureResponse(err);
    res.status(failure.status).json(failure.body);
  }
}

/** Internal verified-webhook reconciliation reuses the normal tenant-scoped importer. */
export async function reconcileWooWebhookProduct(tenantId: number, wooProductId: string, topic: string, parentWooProductId?: string): Promise<void> {
  const knownVariationParent = queryRows<{ wooProductId: string }>(await db.execute(sql`SELECT woo_product_id AS "wooProductId"
    FROM catalog_items WHERE tenant_id = ${tenantId} AND woo_variation_id = ${wooProductId} AND woo_product_id IS NOT NULL LIMIT 1`))[0]?.wooProductId;
  const parentId = parentWooProductId || knownVariationParent;
  if (topic === "product.deleted" && !parentId) {
    await db.execute(sql`UPDATE catalogue_options co SET active = false, updated_at = now()
      FROM catalog_items ci WHERE ci.tenant_id = ${tenantId} AND ci.woo_product_id = ${wooProductId}
        AND ci.tenant_id = co.tenant_id AND ci.id = co.catalog_item_id`);
    await db.update(catalogItemsTable).set({ isAvailable: false, updatedAt: new Date() })
      .where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.wooProductId, wooProductId)));
    return;
  }
  const responseState: { status: number; body: unknown } = { status: 200, body: null };
  const fakeReq = { authorizedTenantId: tenantId } as import("express").Request;
  const fakeRes = {
    status(code: number) { responseState.status = code; return this; },
    json(body: unknown) { responseState.body = body; return this; },
  } as unknown as import("express").Response;
  // Woo can send a variation ID in a product topic. Reconcile its parent so
  // the importer refreshes the complete variation set and deactivates deleted
  // variations without flattening them into standalone products.
  await syncHandler(fakeReq, fakeRes, parentId ?? wooProductId);
  const body = responseState.body as { errors?: unknown[]; skipped?: number } | null;
  if (responseState.status >= 400 || (body?.errors?.length ?? 0) > 0 || (body?.skipped ?? 0) > 0) {
    throw new Error("woo_product_reconciliation_failed");
  }
}

async function enqueueSyncHandler(req: import("express").Request, res: import("express").Response): Promise<void> {
  const tenantId = req.authorizedTenantId!;
  const saved = await getDecryptedWooCreds(tenantId);
  if (!saved.enabled) { res.status(412).json({ error: "WooCommerce synchronization is disabled for this tenant." }); return; }
  if (!saved.storeUrl.trim()) { res.status(412).json({ error: "No WooCommerce Store URL saved." }); return; }
  if (!saved.consumerKey || !saved.consumerSecret) { res.status(412).json({ error: "Saved WooCommerce credentials are incomplete." }); return; }
  try {
    const job = await enqueueWooSync(tenantId, req.dbUser!.id);
    res.status(202).json({ jobId: job.id, state: "queued", reused: job.reused });
  } catch {
    res.status(503).json({ error: "WooCommerce sync could not be queued; retry safely." });
  }
}

// Job insertion is durable before the request is acknowledged. Repeated
// requests return the active tenant job instead of creating overlapping work.
router.post("/admin/woocommerce/sync", requirePermission("settings.manage_tenant"), requireTenantAssignedOrGlobal, enqueueSyncHandler);
router.post("/admin/woocommerce/sync-products", requirePermission("settings.manage_tenant"), requireTenantAssignedOrGlobal, enqueueSyncHandler);
router.get("/admin/woocommerce/sync/jobs/:id", requirePermission("settings.view"), requireTenantAssignedOrGlobal, async (req, res): Promise<void> => {
  const id = typeof req.params.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id) ? req.params.id : null;
  if (!id) { res.status(404).json({ error: "WooCommerce sync job not found" }); return; }
  const job = await getTenantWooSyncJob(req.authorizedTenantId!, id);
  if (!job) { res.status(404).json({ error: "WooCommerce sync job not found" }); return; }
  res.json({ job });
});

const stockReconciliationBody = z.object({
  snapshotId: z.number().int().positive(), itemId: z.number().int().positive(), locationId: z.number().int().positive(),
  policy: z.enum(["initial_import", "audited_adjustment"]), reason: z.string().trim().min(8).max(500),
}).strict();

router.get("/admin/woocommerce/stock-reconciliation/:itemId", requirePermission("inventory.view"), requireTenantAssignedOrGlobal, async (req, res): Promise<void> => {
  const itemId = typeof req.params.itemId === "string" && /^[1-9]\d{0,8}$/.test(req.params.itemId) ? Number(req.params.itemId) : 0;
  if (!itemId || !Number.isSafeInteger(itemId)) { res.status(404).json({ error: "Inventory item not found" }); return; }
  const tenantId = req.authorizedTenantId!;
  const snapshot = queryRows<{ id: number; itemId: number; wooProductId: string; wooVariationId: string | null; management: string; managed: boolean; quantity: string | null; status: string | null; currency: string; observedAt: Date }>(await db.execute(sql`SELECT id,catalog_item_id AS "itemId",woo_product_id AS "wooProductId",
    woo_variation_id AS "wooVariationId",stock_management AS management,managed_stock AS managed,stock_quantity AS quantity,
    stock_status AS status,currency_code AS currency,observed_at AS "observedAt"
    FROM woocommerce_stock_snapshots WHERE tenant_id=${tenantId} AND catalog_item_id=${itemId}
    ORDER BY observed_at DESC LIMIT 1`))[0];
  if (!snapshot) { res.status(404).json({ error: "Woo stock observation not found" }); return; }
  const balances = queryRows<{ locationId: number; locationName: string; quantityOnHand: string }>(await db.execute(sql`SELECT l.id AS "locationId",l.name AS "locationName",COALESCE(b.quantity_on_hand,0)::text AS "quantityOnHand"
    FROM inventory_locations l LEFT JOIN inventory_balances b ON b.tenant_id=l.tenant_id AND b.location_id=l.id AND b.product_id=${itemId}
    WHERE l.tenant_id=${tenantId} AND l.is_active=true ORDER BY l.name,l.id`));
  const assignedLocation = queryRows<{ locationId: number; locationName: string }>(await db.execute(sql`SELECT a.location_id AS "locationId",l.name AS "locationName"
    FROM woocommerce_stock_location_assignments a JOIN inventory_locations l ON l.tenant_id=a.tenant_id AND l.id=a.location_id
    WHERE a.tenant_id=${tenantId} AND a.catalog_item_id=${itemId} LIMIT 1`))[0] ?? null;
  const item = queryRows<{ complianceHeld: boolean; parentHeld: boolean }>(await db.execute(sql`SELECT
    COALESCE(ci.metadata->>'complianceHold'='true',false) AS "complianceHeld",
    EXISTS (SELECT 1 FROM catalog_items parent WHERE parent.tenant_id=ci.tenant_id AND parent.woo_product_id=${snapshot.wooProductId}
      AND parent.woo_variation_id IS NULL AND parent.id<>ci.id AND parent.metadata->>'complianceHold'='true') AS "parentHeld"
    FROM catalog_items ci WHERE ci.tenant_id=${tenantId} AND ci.id=${itemId}`))[0];
  const eligible = snapshot.managed && (snapshot.management === "variation" || snapshot.management === "independent") && snapshot.quantity !== null &&
    item?.complianceHeld !== true && item?.parentHeld !== true;
  res.json({ snapshot, balances, assignedLocation, complianceHeld: item?.complianceHeld ?? false, parentComplianceHeld: item?.parentHeld ?? false,
    reconciliation: { eligible, policy: eligible ? "initial_import_if_no_stock_history_else_audited_adjustment" : "blocked_or_manual_allocation_required" } });
});

router.post("/admin/woocommerce/stock-reconciliation", requirePermission("inventory.manage"), requireTenantAssignedOrGlobal, async (req, res): Promise<void> => {
  const parsed = stockReconciliationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid Woo stock reconciliation request" }); return; }
  const tenantId = req.authorizedTenantId!;
  const actor = req.dbUser!;
  const command = parsed.data;
  try {
    const result = await db.transaction(async tx => {
      // Serialize policy checks and the one-location assignment with inventory
      // movements, preventing simultaneous imports into different locations.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${tenantId}, ${command.itemId})`);
      const snapshot = queryRows<{ id: number; wooProductId: string; wooVariationId: string | null; management: string; managed: boolean; quantity: string | null; currency: string; observedAt: string }>(await tx.execute(sql`SELECT id,woo_product_id AS "wooProductId",woo_variation_id AS "wooVariationId",
        stock_management AS management,managed_stock AS managed,stock_quantity AS quantity,currency_code AS currency,observed_at::text AS "observedAt"
        FROM woocommerce_stock_snapshots s WHERE tenant_id=${tenantId} AND catalog_item_id=${command.itemId}
          AND id=${command.snapshotId} AND observed_at=(SELECT max(latest.observed_at) FROM woocommerce_stock_snapshots latest
            WHERE latest.tenant_id=s.tenant_id AND latest.catalog_item_id=s.catalog_item_id) LIMIT 1`))[0];
      if (!snapshot) throw Object.assign(new Error("stock_snapshot_not_found"), { status: 404 });
      if (!snapshot.managed || (snapshot.management !== "variation" && snapshot.management !== "independent") || snapshot.quantity == null) {
        throw Object.assign(new Error("woo_stock_not_independently_managed"), { status: 409 });
      }
      const [item] = await tx.select({ id: catalogItemsTable.id, metadata: catalogItemsTable.metadata })
        .from(catalogItemsTable).where(and(eq(catalogItemsTable.id, command.itemId), eq(catalogItemsTable.tenantId, tenantId))).limit(1);
      if (!item) throw Object.assign(new Error("catalog_item_not_found"), { status: 404 });
      const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata) ? item.metadata as Record<string, unknown> : {};
      const parentHeld = queryRows<{ held: boolean }>(await tx.execute(sql`SELECT EXISTS (
        SELECT 1 FROM catalog_items parent WHERE parent.tenant_id=${tenantId} AND parent.woo_product_id=${snapshot.wooProductId}
          AND parent.woo_variation_id IS NULL AND parent.id<>${command.itemId} AND parent.metadata->>'complianceHold'='true'
      ) AS held`))[0]?.held === true;
      if (metadata.complianceHold === true || parentHeld) throw Object.assign(new Error("compliance_hold_blocks_stock_import"), { status: 409 });
      const [location] = await tx.select({ id: inventoryLocationsTable.id }).from(inventoryLocationsTable)
        .where(and(eq(inventoryLocationsTable.id, command.locationId), eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.isActive, true))).limit(1);
      if (!location) throw Object.assign(new Error("inventory_location_not_found"), { status: 404 });
      const history = queryRows<{ hasHistory: boolean }>(await tx.execute(sql`SELECT (
          EXISTS (SELECT 1 FROM inventory_movements WHERE tenant_id=${tenantId} AND inventory_entity_type='catalog' AND catalog_item_id=${command.itemId}) OR
          EXISTS (SELECT 1 FROM inventory_balances WHERE tenant_id=${tenantId} AND product_id=${command.itemId} AND quantity_on_hand <> 0) OR
          EXISTS (SELECT 1 FROM inventory_reservations r JOIN orders o ON o.id=r.order_id WHERE o.tenant_id=${tenantId} AND r.catalog_item_id=${command.itemId}) OR
          EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.tenant_id=${tenantId} AND oi.catalog_item_id=${command.itemId})
        ) AS "hasHistory"`))[0]?.hasHistory === true;
      if (!history && command.policy !== "initial_import") throw Object.assign(new Error("initial_import_policy_required_for_untracked_stock"), { status: 409 });
      if (history && command.policy !== "audited_adjustment") throw Object.assign(new Error("audited_adjustment_policy_required_for_existing_stock"), { status: 409 });
      const assignment = queryRows<{ locationId: number }>(await tx.execute(sql`SELECT location_id AS "locationId" FROM woocommerce_stock_location_assignments
        WHERE tenant_id=${tenantId} AND catalog_item_id=${command.itemId} FOR UPDATE`))[0];
      if (assignment && assignment.locationId !== command.locationId) {
        throw Object.assign(new Error("woo_stock_location_assignment_conflict"), { status: 409 });
      }
      if (!assignment) await tx.execute(sql`INSERT INTO woocommerce_stock_location_assignments (tenant_id,catalog_item_id,location_id)
        VALUES (${tenantId},${command.itemId},${command.locationId})`);
      const correction = await postImportedInventoryBalanceCorrection(tx, {
        tenantId, actor: { id: actor.id, email: actor.email, role: actor.role, ipAddress: req.ip }, entityType: "catalog",
        itemId: command.itemId, locationId: command.locationId, targetQuantity: snapshot.quantity,
        sourceType: "woocommerce_stock_reconciliation", sourceId: String(snapshot.id), reasonCode: command.policy,
        reasonText: command.reason, idempotencyKey: `woo-stock:${snapshot.id}:${snapshot.observedAt}:${command.locationId}`,
      });
      const balance = queryRows<{ quantity: string }>(await tx.execute(sql`SELECT quantity_on_hand AS quantity FROM inventory_balances
        WHERE tenant_id=${tenantId} AND product_id=${command.itemId} AND location_id=${command.locationId} LIMIT 1`))[0];
      return { movement: correction, quantityOnHand: balance?.quantity ?? "0", snapshotId: snapshot.id, currency: snapshot.currency };
    });
    res.status(result.movement?.idempotent ? 200 : 201).json(result);
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 500;
    const code = error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message) ? error.message : "stock_reconciliation_failed";
    res.status(status).json({ error: code });
  }
});

// GET /api/admin/woocommerce/status — check if WC credentials are configured
router.get(
  "/admin/woocommerce/status",
  requirePermission("settings.view"),
  requireTenantAssignedOrGlobal,
  async (req, res): Promise<void> => {
    const s = await getOrCreateSettings({ tenantId: req.authorizedTenantId! });
    const hasKey = !!s.wcConsumerKey;
    const hasSecret = !!s.wcConsumerSecret;
    res.json({
      configured: !!s.wcStoreUrl?.trim() && hasKey && hasSecret,
      enabled: s.wcEnabled ?? true,
      storeUrl: s.wcStoreUrl ?? "",
    });
  }
);

/**
 * POST /api/admin/woocommerce/test
 * Issues GET /wp-json/wc/v3/system_status against the configured store with
 * the saved credentials and returns a structured JSON result. Lets admins
 * verify creds without running a full sync.
 *
 * Always returns JSON. 200 on reachable store, 412 if creds are missing,
 * and a safe classified status for authentication, endpoint, timeout, or
 * availability failures. Upstream response bodies are never returned.
 */
router.post(
  "/admin/woocommerce/test",
  requirePermission("settings.manage_tenant"),
  requireTenantAssignedOrGlobal,
  async (req, res): Promise<void> => {
    // Test only the SAVED credentials. We deliberately do not honor
    // request-body overrides (admin-gated SSRF) and we deliberately do
    // not fall back to env vars (so missing persisted config surfaces
    // as a clear 412 instead of silently passing).
    const saved = await getDecryptedWooCreds(req.authorizedTenantId!);
    const storeUrl = saved.storeUrl.trim();
    const consumerKey = saved.consumerKey ?? "";
    const consumerSecret = saved.consumerSecret ?? "";

    if (!storeUrl) {
      res.status(412).json({
        ok: false,
        status: 412,
        code: "woocommerce_store_url_missing",
        message: "No WooCommerce Store URL saved.",
      });
      return;
    }
    if (!consumerKey || !consumerSecret) {
      res.status(412).json({ ok: false, status: 412, code: "woocommerce_credentials_missing", message: "No WooCommerce credentials saved." });
      return;
    }

    const base = storeUrl.replace(/\/$/, "");

    try {
      const r = await fetchWoo(base, "/wp-json/wc/v3/system_status", consumerKey, consumerSecret);
      // Parse minimally to confirm it really is the WC system_status payload.
      const data = await r.json().catch(() => { throw new WooCommerceUpstreamError("malformed"); }) as { environment?: { version?: string } } | null;
      if (!data || typeof data !== "object") throw new WooCommerceUpstreamError("malformed");
      res.json({
        ok: true,
        status: r.status,
        storeUrl: base,
        wcVersion: data?.environment?.version ?? null,
      });
    } catch (err) {
      const failure = wooFailureResponse(err);
      res.status(failure.status).json(failure.body);
    }
  },
);

export default router;
