import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, catalogItemsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved } from "../lib/auth";
import { requirePermission, isGlobalAdmin } from "../lib/roles";
import { requireTenantContext } from "../lib/tenantContext";
import { getOrCreateSettings, getDecryptedWooCreds } from "./settings";
import { wooVariationLabel, wooVariationMetadata, wooVariationOptionValues } from "../lib/wooVariants";

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
  try {
    const response = await fetchWooSafely(storeUrl, path, consumerKey, consumerSecret);
    if (!response.ok) throw classifyWooStatus(response.status);
    return response;
  } catch (error) {
    if (error instanceof WooCommerceUpstreamError) throw error;
    if (error instanceof Error && /timed out/i.test(error.message)) throw new WooCommerceUpstreamError("timeout");
    throw new WooCommerceUpstreamError("unavailable");
  }
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
  tenantId: number; parentProductId: number; parentCatalogItemId: number; wooProductId: string;
  product: WooProduct; variations: WooVariation[];
}): Promise<void> {
  const { tenantId, parentProductId, parentCatalogItemId, wooProductId, product, variations } = input;
  const parent = await db.select().from(catalogItemsTable)
    .where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, parentCatalogItemId))).limit(1);
  if (!parent[0]) throw new Error("Woo variable parent is not tenant-owned");
  const parentMetadata = parent[0].metadata && typeof parent[0].metadata === "object" && !Array.isArray(parent[0].metadata)
    ? parent[0].metadata as Record<string, unknown> : {};
  await db.execute(sql`UPDATE catalogue_options SET active = false WHERE tenant_id = ${tenantId}
    AND product_id = ${parentProductId} AND catalog_item_id = ${parentCatalogItemId}`);
  const seen = new Set<string>();
  for (const variation of variations) {
    if (!variation.id) continue;
    const variationId = String(variation.id);
    seen.add(variationId);
    const values = wooVariationOptionValues(variation.attributes, variationId);
    const label = wooVariationLabel(values);
    const price = variation.regular_price || variation.price || product.regular_price || product.price || "0.00";
    const sale = variation.sale_price || null;
    const imageUrl = variation.image?.src?.trim() || parent[0].imageUrl;
    const barcodeMeta = variation.meta_data?.find(meta => ["barcode", "gtin", "ean", "upc"].includes((meta.key ?? "").toLowerCase()));
    const barcode = typeof barcodeMeta?.value === "string" ? barcodeMeta.value.trim() || null : null;
    const isAvailable = variation.stock_status ? variation.stock_status === "instock" : true;
    const existing = queryRows<{ id: number; metadata: unknown }>(await db.execute(sql`SELECT id, metadata FROM catalog_items
      WHERE tenant_id = ${tenantId} AND woo_product_id = ${wooProductId} AND woo_variation_id = ${variationId} LIMIT 1`))[0];
    let catalogItemId = existing?.id;
    if (!catalogItemId) {
      const created = await db.insert(catalogItemsTable).values({
        tenantId, name: `${product.name ?? parent[0].name} — ${label}`, description: parent[0].description,
        category: parent[0].category, price, compareAtPrice: sale, sku: variation.sku?.trim() || null, barcode,
        isAvailable, isTaxable: parent[0].isTaxable, stockQuantity: "0", imageUrl,
        metadata: wooVariationMetadata(parentMetadata, null, parentCatalogItemId),
        alavontName: `${product.name ?? parent[0].name} — ${label}`, luciferCruzName: `${product.name ?? parent[0].name} — ${label}`,
        customerSafeName: `${product.name ?? parent[0].name} — ${label}`, merchantName: `${product.name ?? parent[0].name} — ${label}`,
        merchantBrand: parent[0].merchantBrand, merchantSku: variation.sku?.trim() || null,
        isWooManaged: true, isLocalAlavont: false, merchantProcessingMode: "woo_native", merchantProductSource: "woo",
        wooProductId, wooVariationId: variationId,
      }).returning({ id: catalogItemsTable.id });
      catalogItemId = created[0]?.id;
    } else {
      const currentMetadata = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
        ? existing.metadata as Record<string, unknown> : {};
      const variantMetadata = { ...wooVariationMetadata(parentMetadata, currentMetadata, parentCatalogItemId),
        isVisible: parentMetadata.isVisible !== false };
      await db.update(catalogItemsTable).set({
        name: `${product.name ?? parent[0].name} — ${label}`, price, compareAtPrice: sale,
        sku: variation.sku?.trim() || null, barcode, isAvailable, imageUrl,
        metadata: variantMetadata, updatedAt: new Date(),
      }).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, catalogItemId)));
    }
    if (!catalogItemId) throw new Error("Woo variation insert did not return an identity");
    await db.transaction(async tx => {
      const own = queryRows<{ optionId: number; generatedProductId: number }>(await tx.execute(sql`SELECT id AS "optionId", product_id AS "generatedProductId"
        FROM catalogue_options WHERE tenant_id = ${tenantId} AND catalog_item_id = ${catalogItemId} LIMIT 1`))[0];
      if (!own) throw new Error("Woo variation inventory identity was not created");
      await tx.execute(sql`UPDATE catalogue_options SET product_id = ${parentProductId}, label = ${label},
        option_values = ${JSON.stringify(values)}::jsonb, active = true, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${own.optionId}`);
      if (own.generatedProductId !== parentProductId) await tx.execute(sql`DELETE FROM catalogue_products
        WHERE tenant_id = ${tenantId} AND id = ${own.generatedProductId}`);
    });
  }
  const previous = queryRows<{ id: number; wooVariationId: string }>(await db.execute(sql`SELECT ci.id, ci.woo_variation_id AS "wooVariationId"
    FROM catalog_items ci JOIN catalogue_options co ON co.tenant_id = ci.tenant_id AND co.catalog_item_id = ci.id
    WHERE ci.tenant_id = ${tenantId} AND ci.woo_product_id = ${wooProductId} AND ci.woo_variation_id IS NOT NULL
      AND co.product_id = ${parentProductId}`));
  for (const old of previous) if (!seen.has(old.wooVariationId)) {
    await db.execute(sql`UPDATE catalogue_options SET active = false, updated_at = now()
      WHERE tenant_id = ${tenantId} AND product_id = ${parentProductId} AND catalog_item_id = ${old.id}`);
    await db.execute(sql`UPDATE catalog_items SET is_available = false, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${old.id}`);
  }
}

// Sync handler — credentials are always loaded (decrypted) from the DB
// via getDecryptedWooCreds(). Request-body overrides are intentionally NOT
// accepted, to avoid an admin-gated SSRF surface.
export async function syncHandler(req: import("express").Request, res: import("express").Response, targetWooProductId?: string): Promise<void> {
    try {
      await ensureWooCatalogSchema();
    } catch {
      res.status(500).json({ error: "Could not prepare WooCommerce catalog schema" });
      return;
    }

    const houseTenantId = req.authorizedTenantId!;

    // Always use the saved (and decrypted) credentials. Request-body
    // overrides are intentionally not accepted to avoid SSRF, and env
    // fallbacks are intentionally not accepted so missing persisted
    // config reliably surfaces as a JSON 412.
    const saved = await getDecryptedWooCreds(req.authorizedTenantId!);
    const consumerKey = saved.consumerKey ?? "";
    const consumerSecret = saved.consumerSecret ?? "";
    const storeUrl = saved.storeUrl.trim();

    if (!storeUrl) {
      res.status(412).json({ error: "No WooCommerce Store URL saved. Configure the tenant Store URL in Admin Settings → WooCommerce." });
      return;
    }
    if (!consumerKey || !consumerSecret) {
      res.status(412).json({ error: "No WooCommerce credentials saved. Go to Admin Settings → WooCommerce and save your API key and secret first." });
      return;
    }

    let products: WooProduct[];
    try {
      products = targetWooProductId
        ? [await fetchWooProduct(storeUrl, targetWooProductId, consumerKey, consumerSecret)]
        : await fetchAllWooProducts(storeUrl, consumerKey, consumerSecret);
    } catch (err) {
      const failure = wooFailureResponse(err);
      res.status(failure.status).json(failure.body);
      return;
    }

    let inserted = 0, updated = 0, skipped = 0;
    const errors: string[] = [];

    for (const product of products) {
      try {
        if (!product.id || !product.name) { skipped++; continue; }

        const wcId = String(product.id);
        const variations = product.type === "variable"
          ? await fetchWooVariations(storeUrl, wcId, consumerKey, consumerSecret) : null;
        const lcName: string = product.name?.trim() || "";
        const salePrice = product.sale_price ? parseFloat(product.sale_price) : null;
        const regularPrice = parseFloat(product.regular_price || product.price || product.sale_price || "0") || 0;
        const category = pickWooCategory(product.categories);
        const imageUrls = (product.images ?? [])
          .map((image) => image.src?.trim() || "")
          .filter(Boolean);
        const imageUrl = imageUrls[0] || null;
        const mediaGallery = imageUrls.map((src) => ({ type: "image" as const, src, alt: lcName }));
        const description = product.description ? stripHtml(product.description) : null;
        const shortDesc = product.short_description ? stripHtml(product.short_description) : null;
        const inStock = product.stock_status ? product.stock_status === "instock" : true;
        const visibleInCatalog = product.catalog_visibility !== "hidden" && product.catalog_visibility !== "search";
        const wcSku = product.sku?.trim() || null;

        if (!lcName) { skipped++; continue; }

        const values = {
          tenantId: houseTenantId,
          name: lcName,
          description: shortDesc || description || null,
          category,
          price: String(regularPrice.toFixed(2)),
          isAvailable: product.type === "variable" ? false : inStock,
          sku: wcSku,
          imageUrl,
          mediaGallery,
          // Dual-brand fields
          regularPrice: String(regularPrice.toFixed(2)),
          homiePrice: salePrice ? String(salePrice.toFixed(2)) : null,
          alavontId: `wc_${wcId}`,
          alavontName: lcName,
          alavontCategory: category,
          alavontImageUrl: imageUrl,
          alavontInStock: inStock,
          alavontIsUpsell: false,
          alavontIsSample: false,
          alavontCreatedDate: product.date_created ?? null,
          alavontUpdatedDate: product.date_modified ?? null,
          luciferCruzName: lcName,
          luciferCruzImageUrl: imageUrl,
          luciferCruzDescription: description,
          luciferCruzCategory: category,
          receiptName: lcName,
          labelName: lcName,
          labName: lcName,
          // Merchant routing — WooCommerce-backed items
          isWooManaged: true,
          isLocalAlavont: false,
          merchantProcessingMode: "woo_native",
          merchantProductSource: "woo",
          merchantBrand: "lucifer_cruz",
          merchantSku: wcSku,
          wooProductId: wcId,
        };

        // Dedup by alavont_id = "wc_{product_id}"
        const [existing] = await db
          .select({ id: catalogItemsTable.id, isLocalAlavont: catalogItemsTable.isLocalAlavont, metadata: catalogItemsTable.metadata })
          .from(catalogItemsTable)
          .where(and(eq(catalogItemsTable.tenantId, houseTenantId), eq(catalogItemsTable.alavontId, `wc_${wcId}`)))
          .limit(1);

        if (existing) {
          // Never overwrite a row that has been reclassified as a local Alavont product.
          // The CSV import is the authority for local items; WooCommerce sync must not win.
          if (existing.isLocalAlavont) {
            skipped++;
          } else {
            const metadata = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
              ? existing.metadata as Record<string, unknown> : {};
            await db.update(catalogItemsTable).set({ ...values, metadata: { ...metadata, isVisible: visibleInCatalog } })
              .where(and(eq(catalogItemsTable.tenantId, houseTenantId), eq(catalogItemsTable.id, existing.id)));
            updated++;
          }
        } else {
          await db.insert(catalogItemsTable).values({ ...values, metadata: { isVisible: visibleInCatalog } });
          inserted++;
        }
        if (variations) {
          const parent = queryRows<{ id: number }>(await db.execute(sql`SELECT id FROM catalog_items
            WHERE tenant_id = ${houseTenantId} AND woo_product_id = ${wcId} AND woo_variation_id IS NULL
            ORDER BY id LIMIT 1`))[0];
          const catalogue = parent && queryRows<{ productId: number }>(await db.execute(sql`SELECT product_id AS "productId"
            FROM catalogue_options WHERE tenant_id = ${houseTenantId} AND catalog_item_id = ${parent.id} LIMIT 1`))[0];
          if (!parent || !catalogue) throw new Error("Woo variable product could not be mapped to its MyOrder parent");
          await syncWooProductVariants({ tenantId: houseTenantId, parentProductId: catalogue.productId,
            parentCatalogItemId: parent.id, wooProductId: wcId, product, variations });
        }
      } catch (err) {
        errors.push(`Product "${String(product.name ?? product.id)}": ${(err as Error)?.message ?? "DB error"}`);
        skipped++;
      }
    }

    res.json({
      inserted,
      updated,
      skipped,
      errors,
      total: products.length,
      storeUrl,
    });
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

// Both URLs are mounted on the SAME shared handler (no internal req.url
// rewrites). The newer `/sync-products` name is preferred; `/sync` is kept
// for back-compat with already-deployed clients.
router.post("/admin/woocommerce/sync", requirePermission("settings.manage_tenant"), requireTenantAssignedOrGlobal, (req, res) => syncHandler(req, res));
router.post("/admin/woocommerce/sync-products", requirePermission("settings.manage_tenant"), requireTenantAssignedOrGlobal, (req, res) => syncHandler(req, res));

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
