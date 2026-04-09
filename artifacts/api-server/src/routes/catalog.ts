import { Router, type IRouter } from "express";
import { eq, and, ilike, asc, desc, sql } from "drizzle-orm";
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
import { requireAuth, loadDbUser, requireDbUser, requireRole } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser);

function mapItem(i: typeof catalogItemsTable.$inferSelect) {
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
    // Dual-brand fields
    alavontName: i.alavontName ?? null,
    alavontCategory: i.alavontCategory ?? null,
    alavontImageUrl: i.alavontImageUrl ?? null,
    alavontInStock: i.alavontInStock ?? null,
    luciferCruzName: i.luciferCruzName ?? null,
    luciferCruzImageUrl: i.luciferCruzImageUrl ?? null,
    luciferCruzDescription: i.luciferCruzDescription ?? null,
    regularPrice: i.regularPrice ? parseFloat(i.regularPrice as string) : null,
    homiePrice: i.homiePrice ? parseFloat(i.homiePrice as string) : null,
    receiptName: i.receiptName ?? null,
    labName: i.labName ?? null,
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

  let rows = await db.select().from(catalogItemsTable)
    .where(actor.tenantId
      ? eq(catalogItemsTable.tenantId, actor.tenantId)
      : undefined)
    .orderBy(asc(catalogItemsTable.name));

  const totalBeforeFilters = rows.length;

  if (query.data.category) {
    const cat = query.data.category;
    rows = rows.filter(r => {
      const lcCat = (r.metadata as any)?.luciferCruzCategory;
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
  const total = rows.length;
  const paged = rows.slice((page - 1) * limit, page * limit);

  console.log(
    `[catalog] tenant=${actor.tenantId} totalInDb=${totalBeforeFilters} afterFilters=${total} returned=${paged.length}` +
    (query.data.category ? ` category="${query.data.category}"` : "") +
    (query.data.search ? ` search="${query.data.search}"` : "")
  );

  res.json(ListCatalogItemsResponse.parse({ items: paged.map(mapItem), total, page, limit }));
});

// POST /api/catalog
router.post("/catalog", requireRole("tenant_admin", "global_admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const body = CreateCatalogItemBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!actor.tenantId) {
    res.status(400).json({ error: "Actor has no tenant" });
    return;
  }
  const [row] = await db.insert(catalogItemsTable).values({
    ...body.data,
    tenantId: actor.tenantId,
    price: String(body.data.price),
    compareAtPrice: body.data.compareAtPrice != null ? String(body.data.compareAtPrice) : null,
    isAvailable: body.data.isAvailable ?? true,
    stockQuantity: body.data.stockQuantity ?? 0,
  }).returning();
  res.status(201).json(mapItem(row));
});

// GET /api/catalog/categories
router.get("/catalog/categories", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  // Collect distinct categories from both alavont_category and category columns
  const rows = await db
    .select({
      alavontCategory: catalogItemsTable.alavontCategory,
      category: catalogItemsTable.category,
    })
    .from(catalogItemsTable)
    .where(actor.tenantId ? eq(catalogItemsTable.tenantId, actor.tenantId) : undefined);

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
  const actor = req.dbUser!;
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
  if (actor.tenantId && actor.role !== "global_admin" && row.tenantId !== actor.tenantId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(GetCatalogItemResponse.parse(mapItem(row)));
});

// PATCH /api/catalog/:id
router.patch("/catalog/:id", requireRole("tenant_admin", "global_admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
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
  if (actor.role !== "global_admin" && existing.tenantId !== actor.tenantId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const updateData: Partial<typeof catalogItemsTable.$inferInsert> = { ...body.data };
  if (body.data.price !== undefined) updateData.price = String(body.data.price);
  if (body.data.compareAtPrice !== undefined) updateData.compareAtPrice = body.data.compareAtPrice != null ? String(body.data.compareAtPrice) : null;
  const [updated] = await db.update(catalogItemsTable).set(updateData).where(eq(catalogItemsTable.id, params.data.id)).returning();
  res.json(UpdateCatalogItemResponse.parse(mapItem(updated)));
});

// DELETE /api/catalog/:id
router.delete("/catalog/:id", requireRole("tenant_admin", "global_admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
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
  if (actor.role !== "global_admin" && existing.tenantId !== actor.tenantId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  await db.delete(catalogItemsTable).where(eq(catalogItemsTable.id, params.data.id));
  res.sendStatus(204);
});

// ─── GET /api/admin/catalog/debug ────────────────────────────────────────────
// Returns a full diagnostic breakdown of catalog items and why some may be hidden.
router.get(
  "/admin/catalog/debug",
  requireRole("tenant_admin", "global_admin"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const allRows = await db.select().from(catalogItemsTable)
      .where(actor.tenantId ? eq(catalogItemsTable.tenantId, actor.tenantId) : undefined)
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
        luciferCruzCategory: (r.metadata as any)?.luciferCruzCategory ?? null,
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

    console.log(`[catalog/debug] tenant=${actor.tenantId} total=${allRows.length} visibleAlavont=${summary.visibleAlavont} visibleLC=${summary.visibleLC}`);

    res.json({ summary, items: analyzed });
  }
);

export default router;
