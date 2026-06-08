import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, productBundlesTable, catalogItemsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

let bundlesSchemaEnsured = false;
async function ensureBundlesSchema(): Promise<void> {
  if (bundlesSchemaEnsured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "product_bundles" (
      "id" serial PRIMARY KEY,
      "tenant_id" integer NOT NULL,
      "name" text NOT NULL,
      "description" text,
      "price" numeric(10, 2) NOT NULL,
      "is_active" boolean NOT NULL DEFAULT true,
      "member_item_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  bundlesSchemaEnsured = true;
}

router.use(async (_req, res, next) => {
  try {
    await ensureBundlesSchema();
    next();
  } catch {
    res.status(500).json({ error: "Could not prepare bundles schema" });
  }
});

function mapBundle(b: typeof productBundlesTable.$inferSelect) {
  return {
    id: b.id,
    tenantId: b.tenantId,
    name: b.name,
    description: b.description ?? null,
    price: parseFloat(b.price as string),
    isActive: b.isActive,
    memberItemIds: Array.isArray(b.memberItemIds) ? (b.memberItemIds as number[]) : [],
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

// GET /api/admin/bundles
router.get("/admin/bundles", requireRole("global_admin", "admin"), async (_req, res): Promise<void> => {
  const tenantId = await getHouseTenantId();
  const bundles = await db
    .select()
    .from(productBundlesTable)
    .where(eq(productBundlesTable.tenantId, tenantId));
  res.json({ bundles: bundles.map(mapBundle) });
});

// POST /api/admin/bundles
router.post("/admin/bundles", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  const { name, description, price, memberItemIds } = req.body as {
    name?: unknown;
    description?: unknown;
    price?: unknown;
    memberItemIds?: unknown;
  };
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const priceNum = parseFloat(String(price));
  if (isNaN(priceNum) || priceNum < 0) {
    res.status(400).json({ error: "price must be a non-negative number" });
    return;
  }
  const rawIds: number[] = Array.isArray(memberItemIds)
    ? memberItemIds.filter((x): x is number => typeof x === "number")
    : [];
  const tenantId = await getHouseTenantId();
  // Validate that every memberItemId exists and belongs to this tenant
  let ids: number[] = [];
  if (rawIds.length > 0) {
    const { inArray } = await import("drizzle-orm");
    const owned = await db
      .select({ id: catalogItemsTable.id })
      .from(catalogItemsTable)
      .where(and(inArray(catalogItemsTable.id, rawIds), eq(catalogItemsTable.tenantId, tenantId)));
    const ownedSet = new Set(owned.map(r => r.id));
    const foreign = rawIds.filter(id => !ownedSet.has(id));
    if (foreign.length > 0) {
      res.status(400).json({ error: `Invalid memberItemIds: ${foreign.join(", ")} not found for this tenant` });
      return;
    }
    ids = rawIds;
  }
  const [row] = await db
    .insert(productBundlesTable)
    .values({
      tenantId,
      name: name.trim(),
      description: typeof description === "string" ? description.trim() || null : null,
      price: String(priceNum),
      memberItemIds: ids,
      isActive: true,
    })
    .returning();
  res.status(201).json(mapBundle(row));
});

// PATCH /api/admin/bundles/:id
router.patch("/admin/bundles/:id", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const tenantId = await getHouseTenantId();
  const [existing] = await db.select().from(productBundlesTable)
    .where(and(eq(productBundlesTable.id, id), eq(productBundlesTable.tenantId, tenantId))).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }
  const { name, description, price, memberItemIds, isActive } = req.body as Record<string, unknown>;
  const patch: Partial<typeof productBundlesTable.$inferInsert> = {};
  if (name !== undefined) patch.name = String(name).trim();
  if (description !== undefined) patch.description = description ? String(description).trim() : null;
  if (price !== undefined) {
    const p = parseFloat(String(price));
    if (isNaN(p) || p < 0) {
      res.status(400).json({ error: "price must be a non-negative number" });
      return;
    }
    patch.price = String(p);
  }
  if (memberItemIds !== undefined) {
    const rawPatchIds: number[] = Array.isArray(memberItemIds)
      ? memberItemIds.filter((x): x is number => typeof x === "number")
      : [];
    if (rawPatchIds.length > 0) {
      const { inArray } = await import("drizzle-orm");
      const owned = await db
        .select({ id: catalogItemsTable.id })
        .from(catalogItemsTable)
        .where(and(inArray(catalogItemsTable.id, rawPatchIds), eq(catalogItemsTable.tenantId, tenantId)));
      const ownedSet = new Set(owned.map(r => r.id));
      const foreign = rawPatchIds.filter(id => !ownedSet.has(id));
      if (foreign.length > 0) {
        res.status(400).json({ error: `Invalid memberItemIds: ${foreign.join(", ")} not found for this tenant` });
        return;
      }
    }
    patch.memberItemIds = rawPatchIds;
  }
  if (isActive !== undefined) patch.isActive = Boolean(isActive);
  const [updated] = await db
    .update(productBundlesTable)
    .set(patch)
    .where(eq(productBundlesTable.id, id))
    .returning();
  res.json(mapBundle(updated));
});

// DELETE /api/admin/bundles/:id
router.delete("/admin/bundles/:id", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const tenantId = await getHouseTenantId();
  const [existing] = await db.select().from(productBundlesTable)
    .where(and(eq(productBundlesTable.id, id), eq(productBundlesTable.tenantId, tenantId))).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Bundle not found" });
    return;
  }
  await db.delete(productBundlesTable).where(and(eq(productBundlesTable.id, id), eq(productBundlesTable.tenantId, tenantId)));
  res.sendStatus(204);
});

// GET /api/admin/bundles/catalog-items
// Returns catalog items for item picker in bundle editor
router.get("/admin/bundles/catalog-items", requireRole("global_admin", "admin"), async (_req, res): Promise<void> => {
  const tenantId = await getHouseTenantId();
  const items = await db
    .select({
      id: catalogItemsTable.id,
      name: catalogItemsTable.name,
      alavontName: catalogItemsTable.alavontName,
      price: catalogItemsTable.price,
      alavontCategory: catalogItemsTable.alavontCategory,
      category: catalogItemsTable.category,
      isAvailable: catalogItemsTable.isAvailable,
      compareAtPrice: catalogItemsTable.compareAtPrice,
    })
    .from(catalogItemsTable)
    .where(and(eq(catalogItemsTable.isWooManaged, false), eq(catalogItemsTable.tenantId, tenantId)));
  res.json({
    items: items.map(i => ({
      id: i.id,
      name: i.alavontName ?? i.name,
      price: parseFloat(i.price as string),
      category: i.alavontCategory ?? i.category,
      isAvailable: i.isAvailable,
      compareAtPrice: i.compareAtPrice ? parseFloat(i.compareAtPrice as string) : null,
    })),
  });
});

// PATCH /api/admin/bundles/set-sale-price/:catalogItemId
// Quick shortcut to set a sale price on a catalog item
router.patch(
  "/admin/bundles/set-sale-price/:catalogItemId",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const itemId = parseInt(req.params.catalogItemId, 10);
    if (isNaN(itemId)) {
      res.status(400).json({ error: "Invalid catalogItemId" });
      return;
    }
    const tenantId = await getHouseTenantId();
    const [existing] = await db
      .select()
      .from(catalogItemsTable)
      .where(and(eq(catalogItemsTable.id, itemId), eq(catalogItemsTable.tenantId, tenantId)))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Catalog item not found" });
      return;
    }
    const { salePrice, clearSale } = req.body as { salePrice?: unknown; clearSale?: boolean };
    if (clearSale) {
      const original = existing.compareAtPrice
        ? parseFloat(existing.compareAtPrice as string)
        : parseFloat(existing.price as string);
      const [updated] = await db
        .update(catalogItemsTable)
        .set({ price: String(original), compareAtPrice: null, isSaleFeatured: false })
        .where(eq(catalogItemsTable.id, itemId))
        .returning();
      res.json({ id: updated.id, price: parseFloat(updated.price as string), compareAtPrice: null });
      return;
    }
    const salePriceNum = parseFloat(String(salePrice));
    if (isNaN(salePriceNum) || salePriceNum < 0) {
      res.status(400).json({ error: "salePrice must be a non-negative number" });
      return;
    }
    const currentPrice = parseFloat(existing.price as string);
    const compareAt = existing.compareAtPrice
      ? parseFloat(existing.compareAtPrice as string)
      : currentPrice;
    const [updated] = await db
      .update(catalogItemsTable)
      .set({
        price: String(salePriceNum),
        compareAtPrice: String(compareAt),
        isSaleFeatured: true,
      })
      .where(eq(catalogItemsTable.id, itemId))
      .returning();
    res.json({
      id: updated.id,
      price: parseFloat(updated.price as string),
      compareAtPrice: parseFloat(updated.compareAtPrice as string),
    });
  }
);

export default router;
