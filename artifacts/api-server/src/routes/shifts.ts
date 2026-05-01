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
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

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

  const customerMap: Record<number, { customerId: number; name: string; orderCount: number; total: number; paymentMethod: string }> = {};
  const paymentTotals: Record<string, number> = {
    cash: 0, card: 0, cashapp: 0, paypal: 0, venmo: 0, comp: 0, other: 0,
  };

  for (const order of shiftOrders) {
    const method = (order as typeof ordersTable.$inferSelect & { paymentMethod?: string }).paymentMethod ?? "cash";
    const orderTotal = parseFloat(order.total as string);
    if (method in paymentTotals) {
      paymentTotals[method] += orderTotal;
    } else {
      paymentTotals.other += orderTotal;
    }

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
        paymentMethod: method,
      };
    }
    customerMap[order.customerId].orderCount++;
    customerMap[order.customerId].total += orderTotal;
  }

  return {
    orderCount: shiftOrders.length,
    totalRevenue: shiftOrders.reduce((s, o) => s + parseFloat(o.total as string), 0),
    cashSales: paymentTotals.cash,
    cardSales: paymentTotals.card,
    compSales: paymentTotals.comp,
    paymentTotals,
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
  quantityEnd: number | null;        // computed (start - sold)
  quantityEndActual: number | null;  // physically counted at clock-out
  discrepancy: number | null;        // quantityEnd - quantityEndActual
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
    const qEndActual = item.quantityEndActual != null ? parseFloat(String(item.quantityEndActual)) : null;
    const discrepancy = qEndActual != null ? qEnd - qEndActual : null;
    const flagged = item.rowType === "item" && (qEnd < 0 || (discrepancy != null && discrepancy > 0));

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
      quantityEndActual: isCountable ? qEndActual : null,
      discrepancy: isCountable ? discrepancy : null,
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
        menuPrice: r.menuPrice != null ? parseFloat(String(r.menuPrice)) : null,
        payoutPrice: r.payoutPrice != null ? parseFloat(String(r.payoutPrice)) : null,
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

    const { inventorySnapshot, inventory: legacyInventory = [], cashBankStart } = req.body as {
      inventorySnapshot?: { templateItemId: number; quantityStart: number }[];
      inventory?: { catalogItemId?: number; itemName: string; unitPrice?: number; quantityStart: number }[];
      cashBankStart?: number;
    };

    const [shift] = await db
      .insert(labTechShiftsTable)
      .values({
        tenantId: houseTenantId,
        techId: tech.id,
        status: "active",
        ipAddress: ip,
        cashBankStart: cashBankStart != null ? String(cashBankStart) : "0",
      })
      .returning();

    let inventoryItemsInserted = 0;

    if (inventorySnapshot && inventorySnapshot.length > 0) {
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
      inventoryItemsInserted = inserts.length;
    } else if (legacyInventory.length > 0) {
      const legacyInserts = legacyInventory.map(item => ({
        shiftId: shift.id,
        catalogItemId: item.catalogItemId ?? null,
        itemName: item.itemName,
        unitPrice: String(item.unitPrice ?? 0),
        quantityStart: String(item.quantityStart),
        rowType: "item",
        unitType: "#",
        displayOrder: 0,
      }));
      await db.insert(shiftInventoryItemsTable).values(legacyInserts);
      inventoryItemsInserted = legacyInserts.length;
    }

    res.status(201).json({
      shift,
      _debug: {
        tenantId: houseTenantId,
        techId: tech.id,
        techClerkId: tech.clerkId,
        techRole: tech.role,
        shiftId: shift.id,
        inventoryItemsInserted,
      },
    });
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

    const {
      endingInventory,
      cashBankEnd,
    } = req.body as {
      endingInventory?: { shiftInventoryItemId: number; quantityEndActual: number }[];
      cashBankEnd?: number; // rep-reported ending cash bank
    };

    const stats = await computeShiftStats(activeShift.id);

    const snapshotItems = await db
      .select()
      .from(shiftInventoryItemsTable)
      .where(eq(shiftInventoryItemsTable.shiftId, activeShift.id))
      .orderBy(asc(shiftInventoryItemsTable.displayOrder));

    const enriched = enrichInventoryWithSales(snapshotItems, stats.byItem);

    // Apply actual ending counts from form if provided
    const actualMap = new Map<number, number>(
      (endingInventory ?? []).map(e => [e.shiftInventoryItemId, e.quantityEndActual])
    );

    // Persist ending quantities and actual counts
    for (const item of enriched) {
      if (item.rowType === "item" || item.rowType === "cash") {
        const actualEnd = actualMap.has(item.id) ? actualMap.get(item.id)! : null;
        const expectedEnd = item.quantityEnd ?? (item.quantityStart - item.quantitySold);
        const disc = actualEnd != null ? expectedEnd - actualEnd : null;
        const flagged = item.rowType === "item" && (
          expectedEnd < 0 || (disc != null && disc > 0)
        );

        await db
          .update(shiftInventoryItemsTable)
          .set({
            quantitySold: String(item.quantitySold),
            quantityEnd: String(expectedEnd),
            quantityEndActual: actualEnd != null ? String(actualEnd) : null,
            discrepancy: disc != null ? String(disc) : null,
            isFlagged: flagged,
          })
          .where(eq(shiftInventoryItemsTable.id, item.id));

        // Update enriched item for summary
        item.quantityEnd = expectedEnd;
        item.quantityEndActual = actualEnd;
        item.discrepancy = disc;
        item.isFlagged = flagged;
      }
    }

    const cashBankStart = parseFloat(String(activeShift.cashBankStart ?? 0));
    const expectedCashBank = cashBankStart + stats.cashSales;
    const cashBankEndVal = cashBankEnd ?? null;
    const cashDiscrepancy = cashBankEndVal != null ? expectedCashBank - cashBankEndVal : null;

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
        quantityEndActual: i.quantityEndActual,
        discrepancy: i.discrepancy,
        isFlagged: i.isFlagged,
      }));

    const summary = {
      ...stats,
      inventorySummary,
      cashBankStart,
      cashBankEndReported: cashBankEndVal,
      expectedCashBank,
      cashDiscrepancy,
      clockedInAt: activeShift.clockedInAt,
      clockedOutAt: new Date().toISOString(),
    };

    const [updatedShift] = await db
      .update(labTechShiftsTable)
      .set({
        status: "supervisor_pending",
        clockedOutAt: new Date(),
        cashBankEndReported: cashBankEndVal != null ? String(cashBankEndVal) : null,
        cashBankEnd: cashBankEndVal != null ? String(cashBankEndVal) : null,
        paymentTotalsJson: stats.paymentTotals,
        summary,
      })
      .where(eq(labTechShiftsTable.id, activeShift.id))
      .returning();

    res.json({ summary, shift: updatedShift });
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

    const cashBankStart = parseFloat(String(activeShift.cashBankStart ?? 0));
    const runningCashBank = cashBankStart + stats.cashSales;

    res.json({
      shift: {
        ...activeShift,
        cashBankStart,
        runningCashBank,
        inventory,
        stats,
      },
    });
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
          cashBankStart: parseFloat(String(shift.cashBankStart ?? 0)),
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
    const id = parseInt(String(req.params.id), 10);
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
    const id = parseInt(String(req.params.id), 10);
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
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

    const [deleted] = await db
      .delete(inventoryTemplatesTable)
      .where(eq(inventoryTemplatesTable.id, id))
      .returning();

    if (!deleted) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ ok: true });
  }
);

// ─── POST /api/admin/inventory-template/seed ──────────────────────────────────
// Seeds the canonical inventory template from the Alavont CSR cash box spreadsheet.
// Safe to call multiple times — upserts by item name.
const CSR_INVENTORY_SEED = [
  { itemName: "Squirting Dildo",                                startingQty: 0,    menuPrice: 100, payoutPrice: 90  },
  { itemName: "Real Feel Deluxe No 7 Wallbanger Vibrating Dildo", startingQty: 0, menuPrice: 80,  payoutPrice: 75  },
  { itemName: "Realistic Foreskin Dildo",                       startingQty: 0,    menuPrice: 95,  payoutPrice: 90  },
  { itemName: "Real Feel Deluxe 11 Inch Wall Banger Vibe in Black", startingQty: 8.5, menuPrice: 20, payoutPrice: 15 },
  { itemName: "Silky - Intimate Gel Collection",                startingQty: 2,    menuPrice: 25,  payoutPrice: 20  },
  { itemName: "Aqua - Intimate Gel Collection",                 startingQty: 2,    menuPrice: 40,  payoutPrice: 30  },
  { itemName: "Crimson Brick Condoms",                          startingQty: 8,    menuPrice: 7,   payoutPrice: 6   },
  { itemName: "Obsidian Edge Collection",                       startingQty: 17,   menuPrice: 10,  payoutPrice: 9   },
  { itemName: "Sex Machine with Dildo",                         startingQty: 3.5,  menuPrice: 100, payoutPrice: 100 },
  { itemName: "Vibrating Mechanical Dildo",                     startingQty: 2.32, menuPrice: 12,  payoutPrice: 12  },
  { itemName: "Metal Cockrings",                                startingQty: 10,   menuPrice: 5,   payoutPrice: 5   },
  { itemName: "Blue Cockring",                                  startingQty: 0,    menuPrice: 5,   payoutPrice: 5   },
  { itemName: "Black Cockring",                                 startingQty: 1,    menuPrice: 40,  payoutPrice: 40  },
  { itemName: "Leather Cockrings",                              startingQty: 1,    menuPrice: 25,  payoutPrice: 25  },
  { itemName: "Silicone Cockrings",                             startingQty: 0.5,  menuPrice: 60,  payoutPrice: 60  },
  { itemName: "1 Morning After Pill",                           startingQty: 9,    menuPrice: 20,  payoutPrice: 18  },
  { itemName: "Glass Vase",                                     startingQty: 1,    menuPrice: 10,  payoutPrice: 8   },
  { itemName: "Butane Lighter",                                 startingQty: 2,    menuPrice: 10,  payoutPrice: 8   },
  { itemName: "Oil Burning Massage Candle",                     startingQty: 2,    menuPrice: 10,  payoutPrice: 8   },
  { itemName: "Couples Dice Games",                             startingQty: 3,    menuPrice: 1,   payoutPrice: 0   },
  { itemName: "Midnight Lace Set",                              startingQty: 15,   menuPrice: 6,   payoutPrice: 5   },
  { itemName: "Velvet Embrace Set",                             startingQty: 2,    menuPrice: 4,   payoutPrice: 4   },
  { itemName: "Crimson Silk Ensemble",                          startingQty: 6,    menuPrice: 3,   payoutPrice: 3   },
  { itemName: "Obsidian Desire Set",                            startingQty: 4,    menuPrice: 9,   payoutPrice: 8   },
  { itemName: "Euphoria Lace Collection",                       startingQty: 21,   menuPrice: 6,   payoutPrice: 5   },
  { itemName: "Soft Touch Satin Set",                           startingQty: 114,  menuPrice: 5,   payoutPrice: 5   },
];

router.post(
  "/admin/inventory-template/seed",
  requireRole("admin", "supervisor"),
  async (_req, res): Promise<void> => {
    const houseTenantId = await getHouseTenantId();

    // Fetch existing by item name to avoid duplicates
    const existing = await db
      .select({ id: inventoryTemplatesTable.id, itemName: inventoryTemplatesTable.itemName })
      .from(inventoryTemplatesTable)
      .where(eq(inventoryTemplatesTable.tenantId, houseTenantId));

    const existingNames = new Set(existing.map(r => r.itemName?.toLowerCase()));

    const toInsert = CSR_INVENTORY_SEED
      .filter(item => !existingNames.has(item.itemName.toLowerCase()))
      .map((item, idx) => ({
        tenantId: houseTenantId,
        itemName: item.itemName,
        rowType: "item",
        unitType: "#",
        startingQuantityDefault: String(item.startingQty),
        currentStock: String(item.startingQty),
        menuPrice: String(item.menuPrice),
        payoutPrice: String(item.payoutPrice),
        displayOrder: (existing.length + idx) * 10,
        isActive: true,
        deductionQuantityPerSale: "1",
      }));

    // Update prices for existing rows (in case they were previously seeded without prices)
    for (const item of CSR_INVENTORY_SEED) {
      const match = existing.find(e => e.itemName?.toLowerCase() === item.itemName.toLowerCase());
      if (match) {
        await db
          .update(inventoryTemplatesTable)
          .set({ menuPrice: String(item.menuPrice), payoutPrice: String(item.payoutPrice) })
          .where(eq(inventoryTemplatesTable.id, match.id));
      }
    }

    let inserted: (typeof inventoryTemplatesTable.$inferSelect)[] = [];
    if (toInsert.length > 0) {
      inserted = await db.insert(inventoryTemplatesTable).values(toInsert).returning();
    }

    res.json({ inserted: inserted.length, updated: CSR_INVENTORY_SEED.length - toInsert.length, total: CSR_INVENTORY_SEED.length });
  }
);

// ─── POST /api/shifts/:id/supervisor-checkout ─────────────────────────────────
// Supervisor confirms ending inventory, sets tip %, calculates final amounts.
router.post(
  "/shifts/:id/supervisor-checkout",
  requireRole("admin", "supervisor"),
  async (req, res): Promise<void> => {
    const shiftId = parseInt(String(req.params.id), 10);
    if (isNaN(shiftId)) { res.status(400).json({ error: "Invalid shift ID" }); return; }

    const [shift] = await db
      .select()
      .from(labTechShiftsTable)
      .where(eq(labTechShiftsTable.id, shiftId))
      .limit(1);

    if (!shift) { res.status(404).json({ error: "Shift not found" }); return; }
    if (shift.status !== "supervisor_pending") {
      res.status(409).json({ error: `Shift is not pending supervisor review (status: ${shift.status})` });
      return;
    }

    const { tipPercent } = req.body as { tipPercent?: number };
    if (!tipPercent || ![15, 16, 17, 18].includes(tipPercent)) {
      res.status(400).json({ error: "tipPercent must be 15, 16, 17, or 18" });
      return;
    }

    const supervisor = req.dbUser!;

    const stats = await computeShiftStats(shiftId);
    const snapshotItems = await db
      .select()
      .from(shiftInventoryItemsTable)
      .where(eq(shiftInventoryItemsTable.shiftId, shiftId))
      .orderBy(asc(shiftInventoryItemsTable.displayOrder));
    const inventory = enrichInventoryWithSales(snapshotItems, stats.byItem);

    // Tip is calculated on eligible completed sales subtotal (non-comp, non-voided)
    const eligibleSalesBase = stats.totalRevenue - stats.compSales;
    const tipAmount = Math.round(eligibleSalesBase * (tipPercent / 100) * 100) / 100;

    // Inventory shortage: sum of flagged item discrepancies converted to monetary value
    // Uses unit price from shift items
    let differenceAmount = 0;
    for (const item of inventory) {
      if (item.isFlagged && item.discrepancy != null && item.discrepancy > 0) {
        differenceAmount += item.discrepancy * item.unitPrice;
      }
    }
    differenceAmount = Math.round(differenceAmount * 100) / 100;

    const finalTip = Math.max(0, tipAmount - differenceAmount);

    const cashBankStart = parseFloat(String(shift.cashBankStart ?? 0));
    const cashBankEndReported = parseFloat(String(shift.cashBankEndReported ?? 0));
    // deposit = ending cash - starting cash - final tip - difference
    const depositAmount = Math.max(0, cashBankEndReported - cashBankStart - finalTip - differenceAmount);

    const [finalized] = await db
      .update(labTechShiftsTable)
      .set({
        status: "finalized",
        tipPercentSelected: String(tipPercent),
        tipAmount: String(finalTip),
        differenceAmount: String(differenceAmount),
        depositAmount: String(depositAmount),
        supervisorId: supervisor.id,
        supervisorConfirmedAt: new Date(),
      })
      .where(eq(labTechShiftsTable.id, shiftId))
      .returning();

    res.json({
      shift: finalized,
      checkout: {
        eligibleSalesBase,
        tipPercent,
        tipAmount,
        differenceAmount,
        finalTip,
        cashBankStart,
        cashBankEndReported,
        depositAmount,
        paymentTotals: stats.paymentTotals,
        flaggedItems: inventory.filter(i => i.isFlagged),
      },
    });
  }
);

// ─── GET /api/shifts/pending-supervisor ───────────────────────────────────────
// Returns all shifts awaiting supervisor checkout.
router.get(
  "/shifts/pending-supervisor",
  requireRole("admin", "supervisor"),
  async (_req, res): Promise<void> => {
    const shifts = await db
      .select()
      .from(labTechShiftsTable)
      .where(eq(labTechShiftsTable.status, "supervisor_pending"))
      .orderBy(desc(labTechShiftsTable.clockedOutAt));

    const result = await Promise.all(
      shifts.map(async shift => {
        const [u] = await db
          .select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
          .from(usersTable)
          .where(eq(usersTable.id, shift.techId))
          .limit(1);
        const stats = await computeShiftStats(shift.id);
        return {
          shiftId: shift.id,
          techName: u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : "Unknown",
          techEmail: u?.email ?? "",
          clockedInAt: shift.clockedInAt,
          clockedOutAt: shift.clockedOutAt,
          cashBankStart: parseFloat(String(shift.cashBankStart ?? 0)),
          cashBankEndReported: parseFloat(String(shift.cashBankEndReported ?? 0)),
          paymentTotals: stats.paymentTotals,
          totalRevenue: stats.totalRevenue,
        };
      })
    );

    res.json({ pendingShifts: result });
  }
);

export default router;
