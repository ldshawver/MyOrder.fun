import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, catalogItemsTable, adminSettingsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

// GET /api/admin/inventory — all catalog items with stock data
router.get(
  "/admin/inventory",
  requireRole("admin", "supervisor", "business_sitter"),
  async (req, res): Promise<void> => {
    const houseTenantId = await getHouseTenantId();
    const items = await db
      .select()
      .from(catalogItemsTable)
      .orderBy(catalogItemsTable.category, catalogItemsTable.name);

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
        isAvailable: item.isAvailable,
      })),
      pettyCash: settings?.pettyCash != null ? parseFloat(String(settings.pettyCash)) : 0,
    });
  }
);

// PATCH /api/admin/inventory/:id — update stock_quantity and/or stock_unit
router.patch(
  "/admin/inventory/:id",
  requireRole("admin", "supervisor", "business_sitter"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const { stockQuantity, stockUnit } = req.body as {
      stockQuantity?: number | null;
      stockUnit?: string;
    };

    const patch: Record<string, unknown> = {};
    if (stockQuantity !== undefined) patch.stockQuantity = stockQuantity != null ? String(stockQuantity) : null;
    if (stockUnit !== undefined) patch.stockUnit = stockUnit;
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: "Nothing to update" }); return; }

    const [updated] = await db
      .update(catalogItemsTable)
      .set(patch)
      .where(eq(catalogItemsTable.id, id))
      .returning({ id: catalogItemsTable.id, stockQuantity: catalogItemsTable.stockQuantity, stockUnit: catalogItemsTable.stockUnit });

    if (!updated) { res.status(404).json({ error: "Item not found" }); return; }

    res.json({
      id: updated.id,
      stockQuantity: updated.stockQuantity != null ? parseFloat(String(updated.stockQuantity)) : null,
      stockUnit: updated.stockUnit ?? "#",
    });
  }
);

// PATCH /api/admin/inventory/petty-cash
router.patch(
  "/admin/inventory/petty-cash",
  requireRole("admin", "supervisor"),
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
