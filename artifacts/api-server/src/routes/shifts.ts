import { Router, type IRouter, type Request } from "express";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  labTechShiftsTable,
  shiftInventoryItemsTable,
  ordersTable,
  orderItemsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser);

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

async function computeShiftStats(shiftId: number) {
  // Get all orders assigned to this shift
  const shiftOrders = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.assignedShiftId, shiftId));

  // Get all line items for those orders
  const orderIds = shiftOrders.map(o => o.id);
  let lineItems: Array<{ catalogItemId: number; catalogItemName: string; quantity: number; unitPrice: string; totalPrice: string }> = [];
  for (const orderId of orderIds) {
    const items = await db
      .select()
      .from(orderItemsTable)
      .where(eq(orderItemsTable.orderId, orderId));
    lineItems.push(...items);
  }

  // Aggregate by item
  const itemMap: Record<number, { catalogItemId: number; name: string; qtySold: number; revenue: number }> = {};
  for (const item of lineItems) {
    const key = item.catalogItemId;
    if (!itemMap[key]) {
      itemMap[key] = { catalogItemId: key, name: item.catalogItemName, qtySold: 0, revenue: 0 };
    }
    itemMap[key].qtySold += item.quantity;
    itemMap[key].revenue += parseFloat(item.totalPrice as string);
  }

  // Aggregate by customer
  const customerMap: Record<number, { customerId: number; name: string; orderCount: number; total: number }> = {};
  for (const order of shiftOrders) {
    const key = order.customerId;
    if (!customerMap[key]) {
      const users = await db.select({ firstName: usersTable.firstName, lastName: usersTable.lastName })
        .from(usersTable).where(eq(usersTable.id, key)).limit(1);
      const u = users[0];
      customerMap[key] = {
        customerId: key,
        name: u ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() : "Unknown",
        orderCount: 0,
        total: 0,
      };
    }
    customerMap[key].orderCount++;
    customerMap[key].total += parseFloat(order.total as string);
  }

  const totalRevenue = shiftOrders.reduce((s, o) => s + parseFloat(o.total as string), 0);

  return {
    orderCount: shiftOrders.length,
    totalRevenue,
    byItem: Object.values(itemMap),
    byCustomer: Object.values(customerMap),
  };
}

// POST /api/shifts/clock-in
router.post("/shifts/clock-in", requireRole("staff", "tenant_admin", "global_admin"), async (req, res): Promise<void> => {
  const tech = req.dbUser!;
  if (!tech.tenantId) { res.status(400).json({ error: "No tenant" }); return; }

  // Check for existing active shift
  const existing = await db
    .select()
    .from(labTechShiftsTable)
    .where(and(eq(labTechShiftsTable.techId, tech.id), eq(labTechShiftsTable.status, "active")))
    .limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: "Already clocked in", shift: existing[0] });
    return;
  }

  const { inventory = [] } = req.body as {
    inventory: { catalogItemId?: number; itemName: string; unitPrice: number; quantityStart: number }[];
  };

  const ip = getClientIp(req);
  const [shift] = await db.insert(labTechShiftsTable).values({
    tenantId: tech.tenantId,
    techId: tech.id,
    status: "active",
    ipAddress: ip,
  }).returning();

  // Save inventory
  if (inventory.length > 0) {
    await db.insert(shiftInventoryItemsTable).values(
      inventory.map(item => ({
        shiftId: shift.id,
        catalogItemId: item.catalogItemId ?? null,
        itemName: item.itemName,
        unitPrice: item.unitPrice.toFixed(2),
        quantityStart: item.quantityStart,
      }))
    );
  }

  res.status(201).json({ shift });
});

// POST /api/shifts/clock-out
router.post("/shifts/clock-out", requireRole("staff", "tenant_admin", "global_admin"), async (req, res): Promise<void> => {
  const tech = req.dbUser!;

  const [activeShift] = await db
    .select()
    .from(labTechShiftsTable)
    .where(and(eq(labTechShiftsTable.techId, tech.id), eq(labTechShiftsTable.status, "active")))
    .limit(1);

  if (!activeShift) { res.status(404).json({ error: "No active shift" }); return; }

  const stats = await computeShiftStats(activeShift.id);

  // Get inventory with sold quantities
  const inventoryItems = await db
    .select()
    .from(shiftInventoryItemsTable)
    .where(eq(shiftInventoryItemsTable.shiftId, activeShift.id));

  const inventorySummary = inventoryItems.map(item => {
    const sold = stats.byItem.find(b => b.catalogItemId === item.catalogItemId)?.qtySold ?? 0;
    return {
      itemName: item.itemName,
      unitPrice: parseFloat(item.unitPrice as string),
      quantityStart: item.quantityStart,
      quantitySold: sold,
      quantityRemaining: Math.max(0, item.quantityStart - sold),
    };
  });

  const summary = {
    ...stats,
    inventorySummary,
    clockedInAt: activeShift.clockedInAt,
    clockedOutAt: new Date().toISOString(),
  };

  const [updated] = await db.update(labTechShiftsTable)
    .set({ status: "completed", clockedOutAt: new Date(), summary })
    .where(eq(labTechShiftsTable.id, activeShift.id))
    .returning();

  res.json({ shift: updated, summary });
});

// GET /api/shifts/current
router.get("/shifts/current", requireRole("staff", "tenant_admin", "global_admin"), async (req, res): Promise<void> => {
  const tech = req.dbUser!;

  const [activeShift] = await db
    .select()
    .from(labTechShiftsTable)
    .where(and(eq(labTechShiftsTable.techId, tech.id), eq(labTechShiftsTable.status, "active")))
    .limit(1);

  if (!activeShift) { res.json({ shift: null }); return; }

  const inventory = await db
    .select()
    .from(shiftInventoryItemsTable)
    .where(eq(shiftInventoryItemsTable.shiftId, activeShift.id));

  const stats = await computeShiftStats(activeShift.id);

  // Enrich inventory with sold counts
  const enrichedInventory = inventory.map(item => {
    const sold = stats.byItem.find(b => b.catalogItemId === item.catalogItemId)?.qtySold ?? 0;
    return {
      id: item.id,
      catalogItemId: item.catalogItemId,
      itemName: item.itemName,
      unitPrice: parseFloat(item.unitPrice as string),
      quantityStart: item.quantityStart,
      quantitySold: sold,
      quantityRemaining: Math.max(0, item.quantityStart - sold),
    };
  });

  res.json({
    shift: {
      ...activeShift,
      inventory: enrichedInventory,
      stats,
    },
  });
});

// GET /api/shifts/active-techs (admin: list all active lab techs with IPs)
router.get("/shifts/active-techs", requireRole("tenant_admin", "global_admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const condition = actor.role === "global_admin"
    ? eq(labTechShiftsTable.status, "active")
    : and(eq(labTechShiftsTable.status, "active"), eq(labTechShiftsTable.tenantId, actor.tenantId!));

  const shifts = await db
    .select()
    .from(labTechShiftsTable)
    .where(condition)
    .orderBy(desc(labTechShiftsTable.clockedInAt));

  const result = await Promise.all(shifts.map(async shift => {
    const [tech] = await db
      .select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
      .from(usersTable).where(eq(usersTable.id, shift.techId)).limit(1);
    return {
      shiftId: shift.id,
      techId: shift.techId,
      techName: tech ? `${tech.firstName ?? ""} ${tech.lastName ?? ""}`.trim() : "Unknown",
      techEmail: tech?.email ?? "",
      ipAddress: shift.ipAddress,
      clockedInAt: shift.clockedInAt,
    };
  }));

  res.json({ activeTechs: result });
});

// GET /api/shifts/:id/summary
router.get("/shifts/:id/summary", requireRole("staff", "tenant_admin", "global_admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [shift] = await db.select().from(labTechShiftsTable).where(eq(labTechShiftsTable.id, id)).limit(1);
  if (!shift) { res.status(404).json({ error: "Shift not found" }); return; }

  const inventory = await db.select().from(shiftInventoryItemsTable).where(eq(shiftInventoryItemsTable.shiftId, id));
  const stats = await computeShiftStats(id);

  const inventorySummary = inventory.map(item => {
    const sold = stats.byItem.find(b => b.catalogItemId === item.catalogItemId)?.qtySold ?? 0;
    return {
      itemName: item.itemName,
      unitPrice: parseFloat(item.unitPrice as string),
      quantityStart: item.quantityStart,
      quantitySold: sold,
      quantityRemaining: Math.max(0, item.quantityStart - sold),
    };
  });

  res.json({ shift, stats, inventorySummary });
});

export default router;
