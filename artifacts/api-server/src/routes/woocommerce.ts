import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, catalogItemsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser);

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
  const allProducts: any[] = [];
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

    const products = await res.json() as any[];
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
router.post(
  "/admin/woocommerce/sync",
  requireRole("tenant_admin", "global_admin"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    if (!actor.tenantId) { res.status(400).json({ error: "No tenant" }); return; }

    const {
      storeUrl = process.env.WC_STORE_URL ?? "https://lucifercruz.com",
      consumerKey = process.env.WC_CONSUMER_KEY ?? "",
      consumerSecret = process.env.WC_CONSUMER_SECRET ?? "",
    } = req.body as { storeUrl?: string; consumerKey?: string; consumerSecret?: string };

    if (!consumerKey || !consumerSecret) {
      res.status(400).json({ error: "consumerKey and consumerSecret are required" });
      return;
    }

    let products: any[];
    try {
      products = await fetchAllWooProducts(storeUrl, consumerKey, consumerSecret);
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? "Failed to reach WooCommerce store" });
      return;
    }

    let inserted = 0, updated = 0, skipped = 0;
    const errors: string[] = [];

    for (const product of products) {
      try {
        if (!product.id || !product.name) { skipped++; continue; }

        const wcId = String(product.id);
        const lcName: string = product.name?.trim() || "";
        const regularPrice = parseFloat(product.regular_price) || 0;
        const salePrice = product.sale_price ? parseFloat(product.sale_price) : null;
        const category = product.categories?.[0]?.name?.trim() || "Uncategorized";
        const imageUrl = product.images?.[0]?.src?.trim() || null;
        const description = product.description ? stripHtml(product.description) : null;
        const shortDesc = product.short_description ? stripHtml(product.short_description) : null;
        const inStock = product.stock_status === "instock";
        const wcSku = product.sku?.trim() || null;

        if (!lcName || regularPrice === 0) { skipped++; continue; }

        const values = {
          tenantId: actor.tenantId,
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
          receiptName: lcName,
          labelName: lcName,
          labName: lcName,
        };

        // Dedup by alavont_id = "wc_{product_id}"
        const [existing] = await db
          .select({ id: catalogItemsTable.id })
          .from(catalogItemsTable)
          .where(and(
            eq(catalogItemsTable.tenantId, actor.tenantId),
            eq(catalogItemsTable.alavontId, `wc_${wcId}`),
          ))
          .limit(1);

        if (existing) {
          await db.update(catalogItemsTable).set(values).where(eq(catalogItemsTable.id, existing.id));
          updated++;
        } else {
          await db.insert(catalogItemsTable).values(values);
          inserted++;
        }
      } catch (err: any) {
        errors.push(`Product "${product.name ?? product.id}": ${err?.message ?? "DB error"}`);
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
  requireRole("tenant_admin", "global_admin"),
  async (req, res): Promise<void> => {
    res.json({
      configured: !!(process.env.WC_CONSUMER_KEY && process.env.WC_CONSUMER_SECRET),
      storeUrl: process.env.WC_STORE_URL ?? "https://lucifercruz.com",
    });
  }
);

export default router;
