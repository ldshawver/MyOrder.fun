import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { db, labTechShiftsTable, orderItemsTable, ordersTable, usersTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole("admin", "supervisor"));

function money(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

router.get("/admin/reports/summary", async (_req, res): Promise<void> => {
  const [orders, items, shifts, users] = await Promise.all([
    db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(500),
    db.select().from(orderItemsTable).orderBy(desc(orderItemsTable.createdAt)).limit(2000),
    db.select().from(labTechShiftsTable).orderBy(desc(labTechShiftsTable.createdAt)).limit(200),
    db.select().from(usersTable),
  ]);

  const paidOrders = orders.filter((order) => order.paymentStatus === "paid");
  const revenue = paidOrders.reduce((sum, order) => sum + money(order.total), 0);
  const averageOrderValue = paidOrders.length > 0 ? revenue / paidOrders.length : 0;

  const byDay = new Map<string, { date: string; orders: number; revenue: number }>();
  for (const order of orders) {
    const key = dayKey(new Date(order.createdAt));
    const row = byDay.get(key) ?? { date: key, orders: 0, revenue: 0 };
    row.orders += 1;
    if (order.paymentStatus === "paid") row.revenue += money(order.total);
    byDay.set(key, row);
  }

  const byPayment = new Map<string, { method: string; orders: number; revenue: number }>();
  for (const order of paidOrders) {
    const method = order.paymentMethod ?? "cash";
    const row = byPayment.get(method) ?? { method, orders: 0, revenue: 0 };
    row.orders += 1;
    row.revenue += money(order.total);
    byPayment.set(method, row);
  }

  const byProduct = new Map<string, { name: string; quantity: number; revenue: number }>();
  for (const item of items) {
    const row = byProduct.get(item.catalogItemName) ?? { name: item.catalogItemName, quantity: 0, revenue: 0 };
    row.quantity += item.quantity;
    row.revenue += money(item.totalPrice);
    byProduct.set(item.catalogItemName, row);
  }

  const usersById = new Map(users.map((user) => [user.id, user]));
  const workforce = shifts.map((shift) => {
    const user = usersById.get(shift.techId);
    const summary = (shift.summary ?? {}) as { totalRevenue?: number; orderCount?: number };
    return {
      shiftId: shift.id,
      userId: shift.techId,
      name: [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email || `User ${shift.techId}`,
      status: shift.status,
      clockedInAt: shift.clockedInAt,
      clockedOutAt: shift.clockedOutAt,
      revenue: money(summary.totalRevenue),
      orderCount: Number(summary.orderCount ?? 0),
      differenceAmount: money(shift.differenceAmount),
      depositAmount: money(shift.depositAmount),
    };
  });

  res.json({
    totals: {
      orderCount: orders.length,
      paidOrderCount: paidOrders.length,
      revenue,
      averageOrderValue,
      activeShiftCount: shifts.filter((shift) => shift.status === "active").length,
      discrepancyTotal: workforce.reduce((sum, row) => sum + row.differenceAmount, 0),
    },
    salesTrend: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)).slice(-30),
    paymentTrend: Array.from(byPayment.values()).sort((a, b) => b.revenue - a.revenue),
    productPerformance: Array.from(byProduct.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 30),
    workforce,
    receipts: orders.slice(0, 50).map((order) => ({
      orderId: order.id,
      createdAt: order.createdAt,
      total: money(order.total),
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
    })),
  });
});

export default router;
