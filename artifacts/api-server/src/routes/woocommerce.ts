import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, catalogItemsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import { getOrCreateSettings } from "./settings";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

interface WooProduct {
  id?: number | string;
  name?: string;
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

async function fetchAllWooProducts(storeUrl: string, consumerKey: string, consumerSecret: string) {
  const base = storeUrl.replace(/\/$/, "");
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
<<<<<<< HEAD
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allProducts: any[] = [];
=======
  const allProducts: WooProduct[] = [];
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
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

// POST /api/admin/woocommerce/sync
// Credentials are loaded from the DB (saved via PUT /api/admin/settings/woocommerce).
// Any values passed in the request body override the saved credentials for this
// one sync — useful for testing new keys without overwriting the saved ones.
router.post(
  "/admin/woocommerce/sync",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    const houseTenantId = await getHouseTenantId();

    // Load saved credentials from DB, fall back to env vars for legacy deploys
    const savedSettings = await getOrCreateSettings();
    const savedKey = savedSettings.wcConsumerKey ?? process.env.WC_CONSUMER_KEY ?? "";
    const savedSecret = savedSettings.wcConsumerSecret ?? process.env.WC_CONSUMER_SECRET ?? "";
    const savedUrl = savedSettings.wcStoreUrl ?? process.env.WC_STORE_URL ?? "https://lucifercruz.com";

    const {
      storeUrl = savedUrl,
      consumerKey = savedKey,
      consumerSecret = savedSecret,
    } = req.body as { storeUrl?: string; consumerKey?: string; consumerSecret?: string };

    if (!consumerKey || !consumerSecret) {
      res.status(400).json({ error: "No WooCommerce credentials saved. Go to Admin Settings → WooCommerce and save your API key and secret first." });
      return;
    }

<<<<<<< HEAD
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let products: any[];
=======
    let products: WooProduct[];
>>>>>>> 0aa2ae4 (Add TypeScript strict mode to api-server and platform tsconfigs; fix resulting errors)
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
        const regularPrice = parseFloat(product.regular_price ?? "0") || 0;
        const salePrice = product.sale_price ? parseFloat(product.sale_price) : null;
        const category = product.categories?.[0]?.name?.trim() || "Uncategorized";
        const imageUrl = product.images?.[0]?.src?.trim() || null;
        const description = product.description ? stripHtml(product.description) : null;
        const shortDesc = product.short_description ? stripHtml(product.short_description) : null;
        const inStock = product.stock_status === "instock";
        const wcSku = product.sku?.trim() || null;

        if (!lcName || regularPrice === 0) { skipped++; continue; }

        const values = {
          tenantId: houseTenantId,
          name: lcName,
          description: shortDesc || description || null,
          category,
          price: String(regularPrice.toFixed(2)),
          isAvailable: inStock,
          sku: wcSku,
          imageUrl,
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
);

// GET /api/admin/woocommerce/status — check if WC credentials are configured
router.get(
  "/admin/woocommerce/status",
  requireRole("admin", "supervisor"),
  async (_req, res): Promise<void> => {
    const s = await getOrCreateSettings();
    const hasKey = !!(s.wcConsumerKey ?? process.env.WC_CONSUMER_KEY);
    const hasSecret = !!(s.wcConsumerSecret ?? process.env.WC_CONSUMER_SECRET);
    res.json({
      configured: hasKey && hasSecret,
      storeUrl: s.wcStoreUrl ?? process.env.WC_STORE_URL ?? "https://lucifercruz.com",
    });
  }
);

export default router;
