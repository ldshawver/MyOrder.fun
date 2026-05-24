import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, catalogItemsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import { getOrCreateSettings, getDecryptedWooCreds } from "./settings";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

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
  sku?: string;
  date_created?: string | null;
  date_modified?: string | null;
}

const LC_MAIN_CATEGORIES = [
  "Anal Play",
  "Apparel & Accessories",
  "Cock & Ball",
  "Kink & Fetish",
  "Self Care & Ambiance",
  "Couples Play",
  "Membership",
];

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

function pickWooCategory(categories: Array<{ name?: string }> | undefined): string {
  const names = (categories ?? [])
    .map((cat) => decodeHtmlEntities(cat.name?.trim() || ""))
    .filter(Boolean);
  return names.find((name) => LC_MAIN_CATEGORIES.includes(name)) || names[0] || "Uncategorized";
}

async function fetchAllWooProducts(storeUrl: string, consumerKey: string, consumerSecret: string) {
  const base = storeUrl.replace(/\/$/, "");
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const allProducts: WooProduct[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `${base}/wp-json/wc/v3/products?per_page=${perPage}&page=${page}&status=publish`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`WooCommerce API error (page ${page}): ${res.status} ${text.substring(0, 200)}`);
    }

    const products = await res.json() as WooProduct[];
    if (!Array.isArray(products) || products.length === 0) break;
    allProducts.push(...products);

    // Check total pages from header
    const totalPages = parseInt(res.headers.get("X-WP-TotalPages") ?? "1", 10);
    if (page >= totalPages || products.length < perPage) break;
    page++;
  }

  return allProducts;
}

// Sync handler — credentials are always loaded (decrypted) from the DB
// via getDecryptedWooCreds(). Request-body overrides are intentionally NOT
// accepted, to avoid an admin-gated SSRF surface.
async function syncHandler(_req: import("express").Request, res: import("express").Response): Promise<void> {
    try {
      await ensureWooCatalogSchema();
    } catch {
      res.status(500).json({ error: "Could not prepare WooCommerce catalog schema" });
      return;
    }

    const houseTenantId = await getHouseTenantId();

    // Always use the saved (and decrypted) credentials. Request-body
    // overrides are intentionally not accepted to avoid SSRF, and env
    // fallbacks are intentionally not accepted so missing persisted
    // config reliably surfaces as a JSON 412.
    const saved = await getDecryptedWooCreds();
    const consumerKey = saved.consumerKey ?? "";
    const consumerSecret = saved.consumerSecret ?? "";
    const storeUrl = saved.storeUrl || "https://lucifercruz.com";

    if (!consumerKey || !consumerSecret) {
      res.status(412).json({ error: "No WooCommerce credentials saved. Go to Admin Settings → WooCommerce and save your API key and secret first." });
      return;
    }

    let products: WooProduct[];
    try {
      products = await fetchAllWooProducts(storeUrl, consumerKey, consumerSecret);
    } catch (err) {
      res.status(502).json({ error: (err as Error)?.message ?? "Failed to reach WooCommerce store" });
      return;
    }

    let inserted = 0, updated = 0, skipped = 0;
    const errors: string[] = [];

    for (const product of products) {
      try {
        if (!product.id || !product.name) { skipped++; continue; }

        const wcId = String(product.id);
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
        const wcSku = product.sku?.trim() || null;

        if (!lcName) { skipped++; continue; }

        const values = {
          tenantId: houseTenantId,
          name: lcName,
          description: shortDesc || description || null,
          category,
          price: String(regularPrice.toFixed(2)),
          isAvailable: inStock,
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
          .select({ id: catalogItemsTable.id })
          .from(catalogItemsTable)
          .where(eq(catalogItemsTable.alavontId, `wc_${wcId}`))
          .limit(1);

        if (existing) {
          await db.update(catalogItemsTable).set(values).where(eq(catalogItemsTable.id, existing.id));
          updated++;
        } else {
          await db.insert(catalogItemsTable).values(values);
          inserted++;
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

// Both URLs are mounted on the SAME shared handler (no internal req.url
// rewrites). The newer `/sync-products` name is preferred; `/sync` is kept
// for back-compat with already-deployed clients.
router.post("/admin/woocommerce/sync", requireRole("global_admin", "admin"), syncHandler);
router.post("/admin/woocommerce/sync-products", requireRole("global_admin", "admin"), syncHandler);

// GET /api/admin/woocommerce/status — check if WC credentials are configured
router.get(
  "/admin/woocommerce/status",
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    const s = await getOrCreateSettings();
    const hasKey = !!(s.wcConsumerKey ?? process.env.WC_CONSUMER_KEY);
    const hasSecret = !!(s.wcConsumerSecret ?? process.env.WC_CONSUMER_SECRET);
    res.json({
      configured: hasKey && hasSecret,
      enabled: s.wcEnabled ?? true,
      storeUrl: s.wcStoreUrl ?? process.env.WC_STORE_URL ?? "https://lucifercruz.com",
    });
  }
);

/**
 * POST /api/admin/woocommerce/test
 * Issues GET /wp-json/wc/v3/system_status against the configured store with
 * the saved credentials and returns a structured JSON result. Lets admins
 * verify creds without running a full sync.
 *
 * Always returns JSON. 200 on reachable store, 412 if creds missing,
 * 502 with { ok:false, status, message } on auth/network failure.
 */
router.post(
  "/admin/woocommerce/test",
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    // Test only the SAVED credentials. We deliberately do not honor
    // request-body overrides (admin-gated SSRF) and we deliberately do
    // not fall back to env vars (so missing persisted config surfaces
    // as a clear 412 instead of silently passing).
    const saved = await getDecryptedWooCreds();
    const storeUrl = saved.storeUrl ?? "https://lucifercruz.com";
    const consumerKey = saved.consumerKey ?? "";
    const consumerSecret = saved.consumerSecret ?? "";

    if (!consumerKey || !consumerSecret) {
      res.status(412).json({
        ok: false,
        status: 412,
        message: "No WooCommerce credentials saved.",
      });
      return;
    }

    const base = storeUrl.replace(/\/$/, "");
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const url = `${base}/wp-json/wc/v3/system_status`;

    try {
      const r = await fetch(url, {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
      });
      if (!r.ok) {
        const text = await r.text();
        res.status(502).json({
          ok: false,
          status: r.status,
          message: `WooCommerce returned ${r.status}: ${text.substring(0, 200)}`,
        });
        return;
      }
      // Parse minimally to confirm it really is the WC system_status payload.
      const data = await r.json().catch(() => null) as { environment?: { version?: string } } | null;
      res.json({
        ok: true,
        status: r.status,
        storeUrl: base,
        wcVersion: data?.environment?.version ?? null,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        status: 0,
        message: (err as Error)?.message ?? "Network error reaching WooCommerce store",
      });
    }
  },
);

export default router;
