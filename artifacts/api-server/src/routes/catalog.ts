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
  return {
    id: i.id,
    tenantId: i.tenantId,
    name: i.name,
    description: i.description,
    category: i.category,
    sku: i.sku,
    price: parseFloat(i.price as string),
    compareAtPrice: i.compareAtPrice ? parseFloat(i.compareAtPrice as string) : undefined,
    stockQuantity: i.stockQuantity,
    isAvailable: i.isAvailable,
    imageUrl: i.imageUrl,
    tags: i.tags ?? [],
    metadata: i.metadata,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
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

  // Any authenticated user can browse the catalog.
  // Scoped to their tenant if they have one, otherwise show all available items.
  let rows = await db.select().from(catalogItemsTable)
    .where(actor.tenantId
      ? eq(catalogItemsTable.tenantId, actor.tenantId)
      : undefined)
    .orderBy(asc(catalogItemsTable.name));

  if (query.data.category) {
    rows = rows.filter(r => r.category === query.data.category);
  }
  if (query.data.search) {
    const s = query.data.search.toLowerCase();
    rows = rows.filter(r => r.name.toLowerCase().includes(s) || (r.description ?? "").toLowerCase().includes(s));
  }
  if (query.data.available !== undefined) {
    rows = rows.filter(r => r.isAvailable === query.data.available);
  }

  const page = query.data.page ?? 1;
  const limit = query.data.limit ?? 20;
  const total = rows.length;
  const paged = rows.slice((page - 1) * limit, page * limit);

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
  const rows = await db
    .selectDistinct({ category: catalogItemsTable.category })
    .from(catalogItemsTable)
    .where(actor.tenantId ? eq(catalogItemsTable.tenantId, actor.tenantId) : undefined)
    .orderBy(asc(catalogItemsTable.category));
  res.json(ListCatalogCategoriesResponse.parse({ categories: rows.map(r => r.category) }));
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
  // Block only if user has a tenant AND it doesn't match (not if they have no tenant)
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

export default router;
