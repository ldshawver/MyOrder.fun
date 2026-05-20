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

type ReportFilters = {
  dateFrom?: Date;
  dateTo?: Date;
  csrId?: number;
  paymentMethod?: string;
  product?: string;
};

function parseFilters(query: Record<string, unknown>): ReportFilters {
  const filters: ReportFilters = {};
  if (typeof query.dateFrom === "string" && query.dateFrom) {
    const d = new Date(`${query.dateFrom}T00:00:00`);
    if (!isNaN(d.getTime())) filters.dateFrom = d;
  }
  if (typeof query.dateTo === "string" && query.dateTo) {
    const d = new Date(`${query.dateTo}T23:59:59`);
    if (!isNaN(d.getTime())) filters.dateTo = d;
  }
  if (typeof query.csrId === "string" && query.csrId) {
    const n = Number(query.csrId);
    if (Number.isInteger(n) && n > 0) filters.csrId = n;
  }
  if (typeof query.paymentMethod === "string" && query.paymentMethod && query.paymentMethod !== "all") {
    filters.paymentMethod = query.paymentMethod;
  }
  if (typeof query.product === "string" && query.product.trim()) {
    filters.product = query.product.trim().toLowerCase();
  }
  return filters;
}

function filterOrders<T extends typeof ordersTable.$inferSelect>(orders: T[], filters: ReportFilters): T[] {
  return orders.filter((order) => {
    const createdAt = new Date(order.createdAt);
    if (filters.dateFrom && createdAt < filters.dateFrom) return false;
    if (filters.dateTo && createdAt > filters.dateTo) return false;
    if (filters.csrId && order.assignedCsrUserId !== filters.csrId) return false;
    if (filters.paymentMethod && (order.paymentMethod ?? "cash") !== filters.paymentMethod) return false;
    return true;
  });
}

function csvEscape(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function buildReport(query: Record<string, unknown>) {
  const filters = parseFilters(query);
  const [orders, items, shifts, users] = await Promise.all([
    db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(500),
    db.select().from(orderItemsTable).orderBy(desc(orderItemsTable.createdAt)).limit(2000),
    db.select().from(labTechShiftsTable).orderBy(desc(labTechShiftsTable.createdAt)).limit(200),
    db.select().from(usersTable),
  ]);

  let filteredOrders = filterOrders(orders, filters);
  if (filters.product) {
    const matchingOrderIds = new Set(
      items
        .filter((item) => item.catalogItemName.toLowerCase().includes(filters.product!))
        .map((item) => item.orderId),
    );
    filteredOrders = filteredOrders.filter((order) => matchingOrderIds.has(order.id));
  }
  const allowedOrderIds = new Set(filteredOrders.map((order) => order.id));
  const filteredItems = items.filter((item) => {
    if (!allowedOrderIds.has(item.orderId)) return false;
    if (filters.product && !item.catalogItemName.toLowerCase().includes(filters.product)) return false;
    return true;
  });
  const filteredShifts = filters.csrId ? shifts.filter((shift) => shift.techId === filters.csrId) : shifts;
  const paidOrders = filteredOrders.filter((order) => order.paymentStatus === "paid");
  const revenue = paidOrders.reduce((sum, order) => sum + money(order.total), 0);
  const averageOrderValue = paidOrders.length > 0 ? revenue / paidOrders.length : 0;

  const byDay = new Map<string, { date: string; orders: number; revenue: number }>();
  for (const order of filteredOrders) {
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
  for (const item of filteredItems) {
    const row = byProduct.get(item.catalogItemName) ?? { name: item.catalogItemName, quantity: 0, revenue: 0 };
    row.quantity += item.quantity;
    row.revenue += money(item.totalPrice);
    byProduct.set(item.catalogItemName, row);
  }

  const usersById = new Map(users.map((user) => [user.id, user]));
  const workforce = filteredShifts.map((shift) => {
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

  return {
    totals: {
      orderCount: filteredOrders.length,
      paidOrderCount: paidOrders.length,
      revenue,
      averageOrderValue,
      activeShiftCount: filteredShifts.filter((shift) => shift.status === "active").length,
      discrepancyTotal: workforce.reduce((sum, row) => sum + row.differenceAmount, 0),
    },
    salesTrend: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)).slice(-30),
    paymentTrend: Array.from(byPayment.values()).sort((a, b) => b.revenue - a.revenue),
    productPerformance: Array.from(byProduct.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 30),
    workforce,
    receipts: filteredOrders.slice(0, 50).map((order) => ({
      orderId: order.id,
      createdAt: order.createdAt,
      total: money(order.total),
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
    })),
  };
}

router.get("/admin/reports/summary", async (req, res): Promise<void> => {
  res.json(await buildReport(req.query));
});

router.get("/admin/reports/export.csv", async (req, res): Promise<void> => {
  const report = await buildReport(req.query);
  const lines = [
    ["section", "name", "count", "revenue"].map(csvEscape).join(","),
    ...report.salesTrend.map(row => ["sales_trend", row.date, row.orders, row.revenue].map(csvEscape).join(",")),
    ...report.paymentTrend.map(row => ["payment", row.method, row.orders, row.revenue].map(csvEscape).join(",")),
    ...report.productPerformance.map(row => ["product", row.name, row.quantity, row.revenue].map(csvEscape).join(",")),
    ...report.workforce.map(row => ["workforce", `${row.name} shift ${row.shiftId}`, row.orderCount, row.revenue].map(csvEscape).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"myorder-reports.csv\"");
  res.send(`${lines.join("\n")}\n`);
});

export default router;
