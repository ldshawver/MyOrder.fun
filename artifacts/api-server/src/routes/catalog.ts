import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { db, catalogItemsTable } from "@workspace/db";
import {
  ListCatalogItemsQueryParams,
  ListCatalogItemsResponse,
  CreateCatalogItemBody,
  GetCatalogItemParams,
  GetCatalogItemResponse,
  UpdateCatalogItemParams,
  UpdateCatalogItemBody,
  UpdateCatalogItemResponse,
  DeleteCatalogItemParams,
  ListCatalogCategoriesResponse,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

function mapItem(i: typeof catalogItemsTable.$inferSelect, alavontOnly = false) {
  // Prefer alavont_image_url for the primary imageUrl; fall back to image_url
  const resolvedImageUrl = i.alavontImageUrl ?? i.imageUrl ?? undefined;
  return {
    id: i.id,
    tenantId: i.tenantId,
    name: i.name,
    description: i.description,
    category: i.alavontCategory ?? i.category,
    sku: i.sku,
    price: parseFloat(i.price as string),
    compareAtPrice: i.compareAtPrice ? parseFloat(i.compareAtPrice as string) : undefined,
    stockQuantity: i.stockQuantity != null ? parseFloat(String(i.stockQuantity)) : null,
    isAvailable: i.isAvailable,
    imageUrl: resolvedImageUrl,
    tags: i.tags ?? [],
    metadata: i.metadata,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    // Dual-brand fields — LC merchant names suppressed in Alavont-only mode
    alavontName: i.alavontName ?? null,
    alavontCategory: i.alavontCategory ?? null,
    alavontImageUrl: i.alavontImageUrl ?? null,
    alavontInStock: i.alavontInStock ?? null,
    luciferCruzName: alavontOnly ? null : (i.luciferCruzName ?? null),
    luciferCruzImageUrl: alavontOnly ? null : (i.luciferCruzImageUrl ?? null),
    luciferCruzDescription: alavontOnly ? null : (i.luciferCruzDescription ?? null),
    luciferCruzCategory: alavontOnly ? null : (i.luciferCruzCategory ?? null),
    regularPrice: i.regularPrice ? parseFloat(i.regularPrice as string) : null,
    homiePrice: i.homiePrice ? parseFloat(i.homiePrice as string) : null,
    receiptName: i.receiptName ?? null,
    labName: i.labName ?? null,
    // Merchant routing fields — suppressed in Alavont-only (storefront) mode
    merchantProcessingMode: alavontOnly ? null : (i.merchantProcessingMode ?? null),
    merchantProductSource: alavontOnly ? null : (i.merchantProductSource ?? null),
    isWooManaged: alavontOnly ? false : (i.isWooManaged ?? false),
    isLocalAlavont: i.isLocalAlavont ?? true,
    wooProductId: alavontOnly ? null : (i.wooProductId ?? null),
    wooVariationId: alavontOnly ? null : (i.wooVariationId ?? null),
  };
}

// GET /api/catalog
router.get("/catalog", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const query = ListCatalogItemsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const catalogMode = query.data.mode ?? "alavont";
  const isLuciferMode = catalogMode === "lucifer";
  // Admin and supervisor users always receive full routing fields (isWooManaged, wooProductId,
  // merchantProcessingMode, luciferCruzName, etc.) regardless of mode — suppression is for
  // storefront/end-customer views only. This prevents catalog edits from accidentally
  // overwriting live routing config with suppressed null/false defaults.
  const isAdminActor = actor.role === "admin" || actor.role === "supervisor";
  const alavontOnly = !isLuciferMode && !isAdminActor;

  let rows = await db.select().from(catalogItemsTable)
    .orderBy(asc(catalogItemsTable.name));

  const totalBeforeFilters = rows.length;

  if (query.data.category) {
    const cat = query.data.category;
    rows = rows.filter(r => {
      const lcCat = (r.metadata as Record<string, unknown>)?.luciferCruzCategory;
      return r.alavontCategory === cat || r.category === cat || lcCat === cat;
    });
  }
  if (query.data.search) {
    const s = query.data.search.toLowerCase();
    rows = rows.filter(r =>
      r.name.toLowerCase().includes(s) ||
      (r.description ?? "").toLowerCase().includes(s) ||
      (r.alavontName ?? "").toLowerCase().includes(s) ||
      (r.luciferCruzName ?? "").toLowerCase().includes(s) ||
      (r.labName ?? "").toLowerCase().includes(s)
    );
  }
  if (query.data.available !== undefined) {
    rows = rows.filter(r => r.isAvailable === query.data.available);
  }

  const page = query.data.page ?? 1;
  const limit = query.data.limit ?? 20;

  // In Lucifer mode: only show items with a luciferCruzName or that are woo-managed
  if (isLuciferMode) {
    rows = rows.filter(r => !!r.luciferCruzName?.trim() || r.isWooManaged);
  }

  // In Alavont mode (non-admin): exclude WooCommerce-only items — they belong under Lucifer Cruz
  if (!isLuciferMode && !isAdminActor) {
    rows = rows.filter(r => !r.isWooManaged);
  }

  const total = rows.length;
  const paged = rows.slice((page - 1) * limit, page * limit);

  console.log(
    `[catalog] mode=${catalogMode} totalInDb=${totalBeforeFilters} afterFilters=${total} returned=${paged.length}` +
    (query.data.category ? ` category="${query.data.category}"` : "") +
    (query.data.search ? ` search="${query.data.search}"` : "")
  );

  res.json(ListCatalogItemsResponse.parse({ items: paged.map(i => mapItem(i, alavontOnly)), total, page, limit }));
});

// POST /api/catalog
router.post("/catalog", requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const body = CreateCatalogItemBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const tenantId = await getHouseTenantId();
  const [row] = await db.insert(catalogItemsTable).values({
    ...body.data,
    tenantId,
    price: String(body.data.price),
    compareAtPrice: body.data.compareAtPrice != null ? String(body.data.compareAtPrice) : undefined,
    isAvailable: body.data.isAvailable ?? true,
    stockQuantity: String(body.data.stockQuantity ?? 0),
  }).returning();
  res.status(201).json(mapItem(row));
});

// GET /api/catalog/categories
router.get("/catalog/categories", async (req, res): Promise<void> => {
  // Collect distinct categories from both alavont_category and category columns
  const rows = await db
    .select({
      alavontCategory: catalogItemsTable.alavontCategory,
      category: catalogItemsTable.category,
    })
    .from(catalogItemsTable);

  const seen = new Set<string>();
  const categories: string[] = [];
  for (const r of rows) {
    const cat = r.alavontCategory || r.category;
    if (cat && !seen.has(cat)) {
      seen.add(cat);
      categories.push(cat);
    }
  }
  categories.sort();
  res.json(ListCatalogCategoriesResponse.parse({ categories }));
});

// GET /api/catalog/:id
router.get("/catalog/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetCatalogItemParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.select().from(catalogItemsTable).where(eq(catalogItemsTable.id, params.data.id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(GetCatalogItemResponse.parse(mapItem(row)));
});

// PATCH /api/catalog/:id
router.patch("/catalog/:id", requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateCatalogItemParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateCatalogItemBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [existing] = await db.select().from(catalogItemsTable).where(eq(catalogItemsTable.id, params.data.id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Compute merged state for conditional validation.
  // When null is sent for LC/Woo fields (common from Alavont-mode UI which suppresses them),
  // fall back to the existing DB value so validation doesn't reject standard catalog edits.
  const mergedMode = body.data.merchantProcessingMode ?? existing.merchantProcessingMode ?? "mapped_lucifer";
  const mergedLcName = (body.data.luciferCruzName != null) ? body.data.luciferCruzName : existing.luciferCruzName;
  const mergedIsWoo = body.data.isWooManaged ?? existing.isWooManaged;
  const mergedWooProductId = (body.data.wooProductId != null) ? body.data.wooProductId : existing.wooProductId;

  if (mergedMode === "mapped_lucifer" && !mergedLcName) {
    res.status(400).json({
      error: "merchantProcessingMode=mapped_lucifer requires a luciferCruzName. Set a Lucifer Cruz merchant name before saving.",
    });
    return;
  }
  if (mergedIsWoo && !mergedWooProductId) {
    res.status(400).json({
      error: "isWooManaged=true requires a wooProductId. Set the WooCommerce product ID before enabling Woo-managed mode.",
    });
    return;
  }

  const { price, compareAtPrice, stockQuantity, regularPrice, homiePrice, ...restBodyData } = body.data;
  const updateData: Partial<typeof catalogItemsTable.$inferInsert> = restBodyData as Partial<typeof catalogItemsTable.$inferInsert>;
  if (price !== undefined) updateData.price = String(price);
  if (compareAtPrice !== undefined) updateData.compareAtPrice = compareAtPrice != null ? String(compareAtPrice) : null;
  if (stockQuantity !== undefined) updateData.stockQuantity = stockQuantity != null ? String(stockQuantity) : null;
  if (regularPrice !== undefined) updateData.regularPrice = regularPrice != null ? String(regularPrice) : null;
  if (homiePrice !== undefined) updateData.homiePrice = homiePrice != null ? String(homiePrice) : null;
  // Protect LC/Woo routing fields from null/false-overwrite.
  // Null values in the body (from Alavont-mode UI suppression) must not erase existing data.
  // isWooManaged: false must not downgrade a Woo-managed item without explicit intent.
  if (body.data.luciferCruzName === null && existing.luciferCruzName) delete updateData.luciferCruzName;
  if (body.data.luciferCruzImageUrl === null && existing.luciferCruzImageUrl) delete updateData.luciferCruzImageUrl;
  if (body.data.luciferCruzDescription === null && existing.luciferCruzDescription) delete updateData.luciferCruzDescription;
  if (body.data.luciferCruzCategory === null && existing.luciferCruzCategory) delete updateData.luciferCruzCategory;
  if (body.data.wooProductId === null && existing.wooProductId) delete updateData.wooProductId;
  if (body.data.wooVariationId === null && existing.wooVariationId) delete updateData.wooVariationId;
  if (body.data.merchantProcessingMode === null && existing.merchantProcessingMode) delete updateData.merchantProcessingMode;
  if (body.data.merchantProductSource === null && existing.merchantProductSource) delete updateData.merchantProductSource;
  // Prevent accidental isWooManaged downgrade: false in body when existing is true
  // requires an explicit merchantProcessingMode change in the same request to signal intent.
  if (body.data.isWooManaged === false && existing.isWooManaged === true) {
    if (!body.data.merchantProcessingMode || body.data.merchantProcessingMode === existing.merchantProcessingMode) {
      res.status(400).json({
        error: "Cannot disable isWooManaged without explicitly setting a new merchantProcessingMode. Provide both fields together to change routing mode.",
      });
      return;
    }
  }
  const [updated] = await db.update(catalogItemsTable).set(updateData).where(eq(catalogItemsTable.id, params.data.id)).returning();
  res.json(UpdateCatalogItemResponse.parse(mapItem(updated)));
});

// DELETE /api/catalog/:id
router.delete("/catalog/:id", requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteCatalogItemParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [existing] = await db.select().from(catalogItemsTable).where(eq(catalogItemsTable.id, params.data.id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(catalogItemsTable).where(eq(catalogItemsTable.id, params.data.id));
  res.sendStatus(204);
});

// ─── GET /api/admin/catalog/debug ────────────────────────────────────────────
// Returns a full diagnostic breakdown of catalog items and why some may be hidden.
router.get(
  "/admin/catalog/debug",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    const allRows = await db.select().from(catalogItemsTable)
      .orderBy(asc(catalogItemsTable.id));

    const analyzed = allRows.map(r => {
      const hasAlavontName = !!r.alavontName?.trim();
      const hasLCName = !!r.luciferCruzName?.trim();
      const hasLabName = !!r.labName?.trim();
      const hasPrice = !!(r.regularPrice || r.price);
      const hasCategory = !!(r.alavontCategory?.trim() || r.category?.trim());
      const hasImage = !!(r.alavontImageUrl || r.imageUrl);

      const missingFields: string[] = [];
      if (!hasAlavontName) missingFields.push("alavont_name");
      if (!hasLCName) missingFields.push("lucifer_cruz_name");
      if (!hasLabName) missingFields.push("lab_name");
      if (!hasPrice) missingFields.push("regular_price");
      if (!hasCategory) missingFields.push("alavont_category");

      const filteredBecause: string[] = [];
      if (!hasAlavontName) filteredBecause.push("missing alavont_name → hidden from Alavont catalog display");
      if (!hasLCName) filteredBecause.push("missing lucifer_cruz_name → hidden from Lucifer Cruz tab");
      if (r.isAvailable === false) filteredBecause.push("is_available=false");
      if (r.alavontInStock === false) filteredBecause.push("alavont_in_stock=false");

      return {
        id: r.id,
        tenantId: r.tenantId,
        name: r.name,
        alavontName: r.alavontName,
        alavontId: r.alavontId,
        regularPrice: r.regularPrice ? parseFloat(r.regularPrice as string) : null,
        alavontCategory: r.alavontCategory ?? r.category,
        alavontInStock: r.alavontInStock,
        luciferCruzName: r.luciferCruzName,
        luciferCruzCategory: r.luciferCruzCategory ?? (r.metadata as Record<string, unknown>)?.luciferCruzCategory ?? null,
        merchantProcessingMode: r.merchantProcessingMode ?? null,
        merchantProductSource: r.merchantProductSource ?? null,
        isWooManaged: r.isWooManaged,
        isLocalAlavont: r.isLocalAlavont,
        wooProductId: r.wooProductId ?? null,
        labName: r.labName,
        isAvailable: r.isAvailable,
        hasImage,
        alavontImageUrl: r.alavontImageUrl,
        imageUrl: r.imageUrl,
        missingFields,
        filteredBecause,
        visibleAlavont: hasAlavontName && r.isAvailable !== false,
        visibleLC: hasLCName && r.isAvailable !== false,
      };
    });

    const summary = {
      totalRows: allRows.length,
      visibleAlavont: analyzed.filter(r => r.visibleAlavont).length,
      visibleLC: analyzed.filter(r => r.visibleLC).length,
      hiddenUnavailable: analyzed.filter(r => r.isAvailable === false).length,
      hiddenMissingAlavontName: analyzed.filter(r => !r.alavontName?.trim()).length,
      hiddenMissingLCName: analyzed.filter(r => !r.luciferCruzName?.trim()).length,
      missingPrice: analyzed.filter(r => r.regularPrice === null).length,
      missingLabName: analyzed.filter(r => !r.labName?.trim()).length,
      missingImage: analyzed.filter(r => !r.hasImage).length,
      missingRequiredFields: analyzed.filter(r => r.missingFields.length > 0).length,
      categoryCounts: Object.entries(
        analyzed.reduce((acc, r) => {
          const cat = r.alavontCategory || "Uncategorized";
          acc[cat] = (acc[cat] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      ).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    };

    console.log(`[catalog/debug] total=${allRows.length} visibleAlavont=${summary.visibleAlavont} visibleLC=${summary.visibleLC}`);

    res.json({ summary, items: analyzed });
  }
);

// ─── POST /api/admin/checkout/normalize-preview ───────────────────────────────
// Admin-only: Preview normalized cart from raw catalog item IDs
router.post(
  "/admin/checkout/normalize-preview",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    try {
      const { normalizeCheckoutCart } = await import("../lib/checkoutNormalizer");
      const { items } = req.body as { items?: Array<{ catalogItemId: number; quantity: number }> };
      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ error: "items array required" });
        return;
      }
      const normalized = await normalizeCheckoutCart(items);
      res.json({ normalized });
    } catch (err) {
      res.status(400).json({ error: (err as Error)?.message ?? "Normalization failed" });
    }
  }
);

// ─── POST /api/admin/checkout/merchant-payload-preview ────────────────────────
// Admin-only: Preview the merchant payload that would be sent to the processor
router.post(
  "/admin/checkout/merchant-payload-preview",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    try {
      const { normalizeCheckoutCart, buildMerchantPayloadLines } = await import("../lib/checkoutNormalizer");
      const { getOrCreateSettings } = await import("./settings");
      const { items } = req.body as { items?: Array<{ catalogItemId: number; quantity: number }> };
      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ error: "items array required" });
        return;
      }
      const settings = await getOrCreateSettings();
      const normalized = await normalizeCheckoutCart(items);
      const merchantLines = buildMerchantPayloadLines(normalized, settings.merchantImageEnabled);

      const alavontNamesInPayload = merchantLines.filter(l =>
        normalized.some(n => n.receipt_alavont_name === l.name && n.receipt_alavont_name !== n.receipt_lucifer_name)
      );

      res.json({
        merchant_lines: merchantLines,
        alavont_name_leak_detected: alavontNamesInPayload.length > 0,
        alavont_name_leaks: alavontNamesInPayload.map(l => l.name),
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error)?.message ?? "Preview failed" });
    }
  }
);

// ─── GET /api/admin/receipts/preview ─────────────────────────────────────────
// Admin-only: Preview a rendered receipt in a specific name mode.
// Returns the actual receipt text output (plain-text, 80-column formatted)
// so operators can see exactly what prints in each mode.
router.get(
  "/admin/receipts/preview",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    const mode = (req.query.mode as string) ?? "lucifer_only";
    if (!["alavont_only", "lucifer_only", "both"].includes(mode)) {
      res.status(400).json({ error: "mode must be alavont_only, lucifer_only, or both" });
      return;
    }
    const typedMode = mode as "alavont_only" | "lucifer_only" | "both";

    const { renderCustomerReceipt } = await import("../lib/receiptRenderer");

    // Sample order with dual-brand items covering both local_mapped and woo sources
    const sampleOrder = {
      id: 0,
      orderNumber: "PREVIEW-001",
      customerName: "Preview Customer",
      fulfillmentType: "Pickup",
      paymentStatus: "paid",
      subtotal: 79.98,
      tax: 6.40,
      total: 86.38,
      createdAt: new Date().toISOString(),
      receiptLineNameMode: typedMode,
      dualBrandName: "Alavont / Lucifer Cruz",
      footerMessage: "Thank you for your order!",
      showDiscreetNotice: false,
      showOperatorName: true,
      operatorName: "Preview Operator",
      items: [
        {
          quantity: 2,
          name: "Sample Alavont Product",
          alavontName: "Sample Alavont Product",
          luciferCruzName: "Sample Lucifer Cruz Product",
          unitPrice: 29.99,
          totalPrice: 59.98,
        },
        {
          quantity: 1,
          name: "Woo Alavont Name",
          alavontName: "Woo Alavont Name",
          luciferCruzName: "Woo LC Merchant Name",
          unitPrice: 19.99,
          totalPrice: 19.99,
        },
      ],
    };

    const rendered = renderCustomerReceipt(sampleOrder);

    res.json({
      mode: typedMode,
      rendered_receipt: rendered,
      description: `Receipt preview in '${typedMode}' mode — this is the exact text sent to the printer`,
    });
  }
);

export default router;
