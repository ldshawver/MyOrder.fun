import { Router, type IRouter, type Request } from "express";
import { eq, and, desc, asc } from "drizzle-orm";
import {
  db,
  labTechShiftsTable,
  shiftInventoryItemsTable,
  inventoryTemplatesTable,
  ordersTable,
  orderItemsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser);

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function computeShiftStats(shiftId: number) {
  const shiftOrders = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.assignedShiftId, shiftId));
  const orderIds = shiftOrders.map(o => o.id);

  const lineItems: (typeof orderItemsTable.$inferSelect)[] = [];
  for (const orderId of orderIds) {
    const items = await db
      .select()
      .from(orderItemsTable)
      .where(eq(orderItemsTable.orderId, orderId));
    lineItems.push(...items);
  }

  const itemMap: Record<number, { catalogItemId: number; name: string; qtySold: number; revenue: number }> = {};
  for (const item of lineItems) {
    if (!itemMap[item.catalogItemId]) {
      itemMap[item.catalogItemId] = {
        catalogItemId: item.catalogItemId,
        name: item.catalogItemName,
        qtySold: 0,
        revenue: 0,
      };
    }
    itemMap[item.catalogItemId].qtySold += item.quantity;
    itemMap[item.catalogItemId].revenue += parseFloat(item.totalPrice as string);
  }

  const customerMap: Record<number, { customerId: number; name: string; orderCount: number; total: number }> = {};
  for (const order of shiftOrders) {
    if (!customerMap[order.customerId]) {
      const [u] = await db
        .select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
        .from(usersTable)
        .where(eq(usersTable.id, order.customerId))
        .limit(1);
      customerMap[order.customerId] = {
        customerId: order.customerId,
        name: u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : "Unknown",
        orderCount: 0,
        total: 0,
      };
    }
    customerMap[order.customerId].orderCount++;
    customerMap[order.customerId].total += parseFloat(order.total as string);
  }

  return {
    orderCount: shiftOrders.length,
    totalRevenue: shiftOrders.reduce((s, o) => s + parseFloat(o.total as string), 0),
    byItem: Object.values(itemMap),
    byCustomer: Object.values(customerMap),
  };
}

type EnrichedItem = {
  id: number;
  templateItemId: number | null;
  sectionName: string | null;
  rowType: string;
  unitType: string;
  displayOrder: number;
  catalogItemId: number | null;
  itemName: string;
  unitPrice: number;
  quantityStart: number;
  quantitySold: number;
  quantityEnd: number | null;
  isFlagged: boolean;
};

function enrichInventoryWithSales(
  items: (typeof shiftInventoryItemsTable.$inferSelect)[],
  byItem: { catalogItemId: number; qtySold: number }[],
): EnrichedItem[] {
  return items.map(item => {
    const qStart = parseFloat(String(item.quantityStart ?? 0));
    const soldRecord = item.catalogItemId
      ? byItem.find(b => b.catalogItemId === item.catalogItemId)
      : null;
    const qSold = soldRecord?.qtySold ?? 0;
    const isCountable = item.rowType === "item" || item.rowType === "cash";
    const storedEnd = item.quantityEnd != null ? parseFloat(String(item.quantityEnd)) : null;
    const computedEnd = qStart - qSold;
    const qEnd = storedEnd ?? computedEnd;
    const flagged = item.rowType === "item" && qEnd < 0;

    return {
      id: item.id,
      templateItemId: item.templateItemId ?? null,
      sectionName: item.sectionName ?? null,
      rowType: item.rowType ?? "item",
      unitType: item.unitType ?? "#",
      displayOrder: item.displayOrder ?? 0,
      catalogItemId: item.catalogItemId ?? null,
      itemName: item.itemName,
      unitPrice: parseFloat(String(item.unitPrice ?? 0)),
      quantityStart: qStart,
      quantitySold: isCountable ? qSold : 0,
      quantityEnd: isCountable ? qEnd : null,
      isFlagged: flagged,
    };
  });
}

// ─── GET /api/shifts/inventory-template ───────────────────────────────────────
router.get(
  "/shifts/inventory-template",
  requireRole("business_sitter", "supervisor", "admin"),
  async (req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(inventoryTemplatesTable)
      .where(eq(inventoryTemplatesTable.isActive, true))
      .orderBy(asc(inventoryTemplatesTable.displayOrder));

    res.json({
      template: rows.map(r => ({
        id: r.id,
        sectionName: r.sectionName,
        itemName: r.itemName,
        rowType: r.rowType,
        unitType: r.unitType,
        startingQuantityDefault: parseFloat(String(r.startingQuantityDefault ?? 0)),
        catalogItemId: r.catalogItemId,
        alavontId: r.alavontId,
        displayOrder: r.displayOrder,
      })),
    });
  }
);

// ─── POST /api/shifts/clock-in ────────────────────────────────────────────────
router.post(
  "/shifts/clock-in",
  requireRole("business_sitter", "supervisor", "admin"),
  async (req, res): Promise<void> => {
    const tech = req.dbUser!;

    const existing = await db
      .select()
      .from(labTechShiftsTable)
      .where(
        and(
          eq(labTechShiftsTable.techId, tech.id),
          eq(labTechShiftsTable.status, "active"),
        )
      )
      .limit(1);

    if (existing.length > 0) {
      res.status(409).json({ error: "Already clocked in", shift: existing[0] });
      return;
    }

    const ip = getClientIp(req);
    const houseTenantId = await getHouseTenantId();
    const [shift] = await db
      .insert(labTechShiftsTable)
      .values({ tenantId: houseTenantId, techId: tech.id, status: "active", ipAddress: ip })
      .returning();

    const { inventorySnapshot, inventory: legacyInventory = [] } = req.body as {
      inventorySnapshot?: { templateItemId: number; quantityStart: number }[];
      inventory?: { catalogItemId?: number; itemName: string; unitPrice?: number; quantityStart: number }[];
    };

    if (inventorySnapshot && inventorySnapshot.length > 0) {
      // Load all active template rows to capture section/spacer structure
      const templateRows = await db
        .select()
        .from(inventoryTemplatesTable)
        .where(eq(inventoryTemplatesTable.isActive, true))
        .orderBy(asc(inventoryTemplatesTable.displayOrder));

      const qtyByTemplateId = new Map<number, number>(
        inventorySnapshot.map(s => [s.templateItemId, s.quantityStart])
      );

      const inserts = templateRows.map(row => ({
        shiftId: shift.id,
        templateItemId: row.id,
        sectionName: row.sectionName ?? null,
        rowType: row.rowType,
        unitType: row.unitType ?? "#",
        displayOrder: row.displayOrder,
        catalogItemId: row.catalogItemId ?? null,
        itemName: row.itemName ?? row.sectionName ?? "",
        unitPrice: "0",
        quantityStart: String(
          qtyByTemplateId.has(row.id)
            ? qtyByTemplateId.get(row.id)!
            : parseFloat(String(row.startingQuantityDefault ?? 0))
        ),
        quantitySold: "0",
      }));

      if (inserts.length > 0) {
        await db.insert(shiftInventoryItemsTable).values(inserts);
      }
    } else if (legacyInventory.length > 0) {
      await db.insert(shiftInventoryItemsTable).values(
        legacyInventory.map(item => ({
          shiftId: shift.id,
          catalogItemId: item.catalogItemId ?? null,
          itemName: item.itemName,
          unitPrice: String(item.unitPrice ?? 0),
          quantityStart: String(item.quantityStart),
          rowType: "item",
          unitType: "#",
          displayOrder: 0,
        }))
      );
    }

    res.status(201).json({ shift });
  }
);

// ─── POST /api/shifts/clock-out ───────────────────────────────────────────────
router.post(
  "/shifts/clock-out",
  requireRole("business_sitter", "supervisor", "admin"),
  async (req, res): Promise<void> => {
    const tech = req.dbUser!;

    const [activeShift] = await db
      .select()
      .from(labTechShiftsTable)
      .where(
        and(
          eq(labTechShiftsTable.techId, tech.id),
          eq(labTechShiftsTable.status, "active"),
        )
      )
      .limit(1);

    if (!activeShift) { res.status(404).json({ error: "No active shift" }); return; }

    const stats = await computeShiftStats(activeShift.id);

    const snapshotItems = await db
      .select()
      .from(shiftInventoryItemsTable)
      .where(eq(shiftInventoryItemsTable.shiftId, activeShift.id))
      .orderBy(asc(shiftInventoryItemsTable.displayOrder));

    const enriched = enrichInventoryWithSales(snapshotItems, stats.byItem);

    // Persist ending quantities
    for (const item of enriched) {
      if (item.rowType === "item" || item.rowType === "cash") {
        await db
          .update(shiftInventoryItemsTable)
          .set({
            quantitySold: String(item.quantitySold),
            quantityEnd: String(item.quantityEnd ?? item.quantityStart - item.quantitySold),
            isFlagged: item.isFlagged,
          })
          .where(eq(shiftInventoryItemsTable.id, item.id));
      }
    }

    const inventorySummary = enriched
      .filter(i => i.rowType !== "spacer")
      .map(i => ({
        itemName: i.itemName,
        sectionName: i.sectionName,
        rowType: i.rowType,
        unitType: i.unitType,
        quantityStart: i.quantityStart,
        quantitySold: i.quantitySold,
        quantityEnd: i.quantityEnd ?? i.quantityStart - i.quantitySold,
        isFlagged: i.isFlagged,
      }));

    const summary = {
      ...stats,
      inventorySummary,
      clockedInAt: activeShift.clockedInAt,
      clockedOutAt: new Date().toISOString(),
    };

    const [updated] = await db
      .update(labTechShiftsTable)
      .set({ status: "completed", clockedOutAt: new Date(), summary })
      .where(eq(labTechShiftsTable.id, activeShift.id))
      .returning();

    res.json({ shift: updated, summary });
  }
);

// ─── GET /api/shifts/current ──────────────────────────────────────────────────
router.get(
  "/shifts/current",
  requireRole("business_sitter", "supervisor", "admin"),
  async (req, res): Promise<void> => {
    const tech = req.dbUser!;

    const [activeShift] = await db
      .select()
      .from(labTechShiftsTable)
      .where(
        and(
          eq(labTechShiftsTable.techId, tech.id),
          eq(labTechShiftsTable.status, "active"),
        )
      )
      .limit(1);

    if (!activeShift) { res.json({ shift: null }); return; }

    const snapshotItems = await db
      .select()
      .from(shiftInventoryItemsTable)
      .where(eq(shiftInventoryItemsTable.shiftId, activeShift.id))
      .orderBy(asc(shiftInventoryItemsTable.displayOrder));

    const stats = await computeShiftStats(activeShift.id);
    const inventory = enrichInventoryWithSales(snapshotItems, stats.byItem);

    res.json({ shift: { ...activeShift, inventory, stats } });
  }
);

// ─── GET /api/shifts/active-techs ────────────────────────────────────────────
router.get(
  "/shifts/active-techs",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    const shifts = await db
      .select()
      .from(labTechShiftsTable)
      .where(eq(labTechShiftsTable.status, "active"))
      .orderBy(desc(labTechShiftsTable.clockedInAt));

    const result = await Promise.all(
      shifts.map(async shift => {
        const [u] = await db
          .select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
          .from(usersTable)
          .where(eq(usersTable.id, shift.techId))
          .limit(1);
        return {
          shiftId: shift.id,
          techId: shift.techId,
          techName: u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : "Unknown",
          techEmail: u?.email ?? "",
          ipAddress: shift.ipAddress,
          clockedInAt: shift.clockedInAt,
        };
      })
    );

    res.json({ activeTechs: result });
  }
);

// ─── GET /api/shifts/:id/summary ─────────────────────────────────────────────
router.get(
  "/shifts/:id/summary",
  requireRole("business_sitter", "supervisor", "admin"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

    const [shift] = await db
      .select()
      .from(labTechShiftsTable)
      .where(eq(labTechShiftsTable.id, id))
      .limit(1);

    if (!shift) { res.status(404).json({ error: "Shift not found" }); return; }

    const snapshotItems = await db
      .select()
      .from(shiftInventoryItemsTable)
      .where(eq(shiftInventoryItemsTable.shiftId, id))
      .orderBy(asc(shiftInventoryItemsTable.displayOrder));

    const stats = await computeShiftStats(id);
    const inventory = enrichInventoryWithSales(snapshotItems, stats.byItem);

    res.json({ shift, stats, inventory });
  }
);

// ─── Admin: Inventory Template Management ─────────────────────────────────────

// GET /api/admin/inventory-template
router.get(
  "/admin/inventory-template",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(inventoryTemplatesTable)
      .orderBy(asc(inventoryTemplatesTable.displayOrder));

    res.json({ template: rows });
  }
);

// PATCH /api/admin/inventory-template/:id
router.patch(
  "/admin/inventory-template/:id",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

    const {
      itemName, unitType, startingQuantityDefault, displayOrder, isActive,
      catalogItemId, deductionQuantityPerSale, sectionName, rowType, currentStock,
    } = req.body as {
      itemName?: string;
      unitType?: string;
      startingQuantityDefault?: number;
      displayOrder?: number;
      isActive?: boolean;
      catalogItemId?: number | null;
      deductionQuantityPerSale?: number | null;
      sectionName?: string | null;
      rowType?: string;
      currentStock?: number | null;
    };

    const update: Record<string, unknown> = {};
    if (itemName !== undefined) update.itemName = itemName;
    if (unitType !== undefined) update.unitType = unitType;
    if (startingQuantityDefault !== undefined) update.startingQuantityDefault = String(startingQuantityDefault);
    if (displayOrder !== undefined) update.displayOrder = displayOrder;
    if (isActive !== undefined) update.isActive = isActive;
    if (catalogItemId !== undefined) update.catalogItemId = catalogItemId;
    if (deductionQuantityPerSale !== undefined)
      update.deductionQuantityPerSale = deductionQuantityPerSale != null ? String(deductionQuantityPerSale) : null;
    if (sectionName !== undefined) update.sectionName = sectionName;
    if (rowType !== undefined) update.rowType = rowType;
    if (currentStock !== undefined) update.currentStock = currentStock != null ? String(currentStock) : null;

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [updated] = await db
      .update(inventoryTemplatesTable)
      .set(update)
      .where(eq(inventoryTemplatesTable.id, id))
      .returning();

    if (!updated) { res.status(404).json({ error: "Template item not found" }); return; }
    res.json({ item: updated });
  }
);

// POST /api/admin/inventory-template — create a new raw-material row
router.post(
  "/admin/inventory-template",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    const {
      itemName = "New Item",
      sectionName,
      rowType = "item",
      unitType = "#",
      startingQuantityDefault = 0,
      displayOrder = 9999,
      catalogItemId,
      deductionQuantityPerSale = 1,
    } = req.body as {
      itemName?: string;
      sectionName?: string;
      rowType?: string;
      unitType?: string;
      startingQuantityDefault?: number;
      displayOrder?: number;
      catalogItemId?: number | null;
      deductionQuantityPerSale?: number;
    };

    const houseTenantId = await getHouseTenantId();
    const [created] = await db
      .insert(inventoryTemplatesTable)
      .values({
        tenantId: houseTenantId,
        itemName,
        sectionName: sectionName ?? null,
        rowType,
        unitType,
        startingQuantityDefault: String(startingQuantityDefault),
        displayOrder,
        isActive: true,
        catalogItemId: catalogItemId ?? null,
        deductionQuantityPerSale: String(deductionQuantityPerSale),
        currentStock: String(startingQuantityDefault),
      })
      .returning();

    res.status(201).json({ item: created });
  }
);

// DELETE /api/admin/inventory-template/:id — permanently remove a row
router.delete(
  "/admin/inventory-template/:id",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

    const [deleted] = await db
      .delete(inventoryTemplatesTable)
      .where(eq(inventoryTemplatesTable.id, id))
      .returning();

    if (!deleted) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ ok: true });
  }
);

export default router;
