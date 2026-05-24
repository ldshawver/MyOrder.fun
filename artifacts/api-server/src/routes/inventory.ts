import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, catalogItemsTable, adminSettingsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

let inventoryCatalogSchemaEnsured = false;

async function ensureInventoryCatalogSchema(): Promise<void> {
  if (inventoryCatalogSchemaEnsured) return;
  const statements = [
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "stock_quantity" numeric(10, 2) DEFAULT 0`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "stock_unit" text DEFAULT '#'`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "par_level" numeric(10, 2) DEFAULT 0`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "regular_price" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_woo_managed" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_local_alavont" boolean NOT NULL DEFAULT true`,
  ];
  for (const statement of statements) {
    await db.execute(statement);
  }
  inventoryCatalogSchemaEnsured = true;
}

router.use(async (_req, res, next) => {
  try {
    await ensureInventoryCatalogSchema();
    next();
  } catch {
    res.status(500).json({ error: "Could not prepare inventory schema" });
  }
});

// GET /api/admin/inventory — all catalog items with stock data
router.get(
  "/admin/inventory",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const houseTenantId = await getHouseTenantId();
    const catalogItems = await db
      .select({
        id: catalogItemsTable.id,
        name: catalogItemsTable.name,
        category: catalogItemsTable.category,
        price: catalogItemsTable.price,
        isAvailable: catalogItemsTable.isAvailable,
        alavontName: catalogItemsTable.alavontName,
        luciferCruzName: catalogItemsTable.luciferCruzName,
        alavontCategory: catalogItemsTable.alavontCategory,
        regularPrice: catalogItemsTable.regularPrice,
        stockQuantity: catalogItemsTable.stockQuantity,
        stockUnit: catalogItemsTable.stockUnit,
        parLevel: catalogItemsTable.parLevel,
        isWooManaged: catalogItemsTable.isWooManaged,
        isLocalAlavont: catalogItemsTable.isLocalAlavont,
      })
      .from(catalogItemsTable)
      .orderBy(catalogItemsTable.category, catalogItemsTable.name);
    const items = catalogItems.filter((item) => item.isWooManaged !== true && item.isLocalAlavont !== false);

    // Get petty cash
    const [settings] = await db
      .select({ pettyCash: adminSettingsTable.pettyCash })
      .from(adminSettingsTable)
      .where(eq(adminSettingsTable.tenantId, houseTenantId))
      .limit(1);

    res.json({
      items: items.map(item => ({
        id: item.id,
        name: item.name,
        alavontName: item.alavontName,
        luciferCruzName: item.luciferCruzName,
        category: item.category,
        alavontCategory: item.alavontCategory,
        price: item.price,
        regularPrice: item.regularPrice,
        stockQuantity: item.stockQuantity != null ? parseFloat(String(item.stockQuantity)) : null,
        stockUnit: item.stockUnit ?? "#",
        parLevel: item.parLevel != null ? parseFloat(String(item.parLevel)) : 0,
        isAvailable: item.isAvailable,
      })),
      pettyCash: settings?.pettyCash != null ? parseFloat(String(settings.pettyCash)) : 0,
    });
  }
);

// PATCH /api/admin/inventory/:id — update stock_quantity and/or stock_unit
router.patch(
  "/admin/inventory/:id",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const { stockQuantity, stockUnit, parLevel } = req.body as {
      stockQuantity?: number | null;
      stockUnit?: string;
      parLevel?: number | null;
    };

    const patch: Record<string, unknown> = {};
    if (stockQuantity !== undefined) patch.stockQuantity = stockQuantity != null ? String(stockQuantity) : null;
    if (stockUnit !== undefined) patch.stockUnit = stockUnit;
    if (parLevel !== undefined) patch.parLevel = parLevel != null ? String(parLevel) : "0";
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: "Nothing to update" }); return; }

    const [updated] = await db
      .update(catalogItemsTable)
      .set(patch)
      .where(eq(catalogItemsTable.id, id))
      .returning({ id: catalogItemsTable.id, stockQuantity: catalogItemsTable.stockQuantity, stockUnit: catalogItemsTable.stockUnit, parLevel: catalogItemsTable.parLevel });

    if (!updated) { res.status(404).json({ error: "Item not found" }); return; }

    res.json({
      id: updated.id,
      stockQuantity: updated.stockQuantity != null ? parseFloat(String(updated.stockQuantity)) : null,
      stockUnit: updated.stockUnit ?? "#",
      parLevel: updated.parLevel != null ? parseFloat(String(updated.parLevel)) : 0,
    });
  }
);

// PATCH /api/admin/inventory/petty-cash
router.patch(
  "/admin/inventory/petty-cash",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const { pettyCash } = req.body as { pettyCash: number };
    if (typeof pettyCash !== "number" || isNaN(pettyCash)) {
      res.status(400).json({ error: "pettyCash must be a number" }); return;
    }

    const houseTenantId = await getHouseTenantId();
    await db
      .update(adminSettingsTable)
      .set({ pettyCash: String(pettyCash.toFixed(2)) })
      .where(eq(adminSettingsTable.tenantId, houseTenantId));

    res.json({ pettyCash });
  }
);

export default router;
