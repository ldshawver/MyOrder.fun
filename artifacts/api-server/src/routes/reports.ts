import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, labTechShiftsTable, orderItemsTable, ordersTable, orderTaxSnapshotsTable, usersTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";
import { isGlobalAdmin } from "../lib/roles";
import { requireTenantContext } from "../lib/tenantContext";
import { buildSalesTaxReportFromRows } from "../lib/salesTaxReport";
import {
  emptyHours,
  emptyWeekdays,
  hourInBusinessZone,
  inventoryRollup,
  suggestedOrderLines,
  weekdayInBusinessZone,
  type StockLocationRow,
} from "../lib/reportSeries";

const router: IRouter = Router();
function requireReportTenantContext(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): void {
  if (isGlobalAdmin(req.dbUser) && req.query.tenantId === undefined) {
    req.authorizedTenantId = undefined;
    next();
    return;
  }
  requireTenantContext(req, res, next);
}

const authChain = [requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole("global_admin", "admin"), requireReportTenantContext] as const;
let reportSchemaEnsured = false;

async function ensureReportSchema(): Promise<void> {
  if (reportSchemaEnsured) return;
  const statements = [
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tracking_url" text`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assigned_tech_id" integer`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assigned_shift_id" integer`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "fulfillment_status" text`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "assigned_csr_user_id" integer`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "route_source" text`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "routed_at" timestamp with time zone`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "accepted_at" timestamp with time zone`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "promised_minutes" integer DEFAULT 30`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "estimated_ready_at" timestamp with time zone`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ready_at" timestamp with time zone`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "eta_adjusted_by_supervisor" boolean NOT NULL DEFAULT false`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "purged_at" timestamp with time zone`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "audit_token" text`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "alavont_cart_snapshot" jsonb`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "lucifer_checkout_snapshot" jsonb`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "final_confirmation_at" timestamp with time zone`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "legal_disclaimer_accepted" boolean NOT NULL DEFAULT false`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "legal_disclaimer_text" text`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "checkout_conversion_snapshot" jsonb`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "selected_payment_method" text`,
    `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_method" text`,
    `ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "cash_bank_start" numeric(10,2) DEFAULT 0`,
    `ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "cash_bank_end" numeric(10,2)`,
    `ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "cash_bank_end_reported" numeric(10,2)`,
    `ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "tip_percent_selected" numeric(5,2)`,
    `ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "tip_amount" numeric(10,2)`,
    `ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "difference_amount" numeric(10,2) DEFAULT 0`,
    `ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "deposit_amount" numeric(10,2)`,
    `ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "supervisor_id" integer`,
    `ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "supervisor_confirmed_at" timestamp with time zone`,
    `ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "payment_totals_json" json`,
    `ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "summary" json`,
  ];
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
  reportSchemaEnsured = true;
}

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

type ReportOrder = Pick<typeof ordersTable.$inferSelect, "id" | "tenantId" | "createdAt" | "assignedCsrUserId" | "paymentMethod" | "paymentStatus" | "total">;

function filterOrders<T extends ReportOrder>(orders: T[], filters: ReportFilters): T[] {
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

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | undefined)?.rows ?? []);
}

function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function personName(user: { firstName?: string | null; lastName?: string | null } | undefined, id: number): string {
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  return name || `CSR #${id}`;
}

async function loadStockRows(tenantId: number | undefined): Promise<StockLocationRow[]> {
  if (tenantId == null) return [];
  const probe = resultRows<{ present: string | null }>(await db.execute(sql`SELECT to_regclass('public.inventory_balances') AS present`));
  if (!probe[0]?.present) return [];
  return resultRows<Record<string, unknown>>(await db.execute(sql`
    SELECT DISTINCT ON (ii.id, il.id)
      ii.id AS "inventoryItemId",
      cp.name AS "productName",
      co.label AS "optionLabel",
      il.id AS "locationId",
      il.name AS "locationName",
      COALESCE(b.quantity_on_hand, 0)::text AS "onHand",
      GREATEST(0, COALESCE(b.quantity_on_hand, 0) - COALESCE((
        SELECT SUM(r.quantity) FROM inventory_reservations r
        JOIN orders o ON o.id = r.order_id AND o.tenant_id = ii.tenant_id
        WHERE r.catalog_item_id = ii.catalog_item_id AND r.location_id = il.id AND r.status = 'reserved'
          AND (r.expires_at > now() OR EXISTS (
            SELECT 1 FROM payment_attempts pa
            WHERE pa.tenant_id = ii.tenant_id AND pa.order_id = r.order_id
              AND pa.state IN ('creating','created','approved','capturing','reconciliation_required')
          ))
      ), 0))::text AS available,
      COALESCE(p.par, 0)::text AS par,
      COALESCE(p.reorder_point, 0)::text AS "reorderPoint",
      COALESCE(p.preferred_reorder_quantity, 0)::text AS "preferredReorderQuantity",
      COALESCE(p.moq, 0)::text AS moq,
      il.is_active AS eligible
    FROM inventory_items ii
    JOIN catalogue_options co ON co.tenant_id = ii.tenant_id AND co.inventory_item_id = ii.id AND co.active = true
    JOIN catalogue_products cp ON cp.tenant_id = co.tenant_id AND cp.id = co.product_id AND cp.active = true
    JOIN catalog_items ci ON ci.tenant_id = co.tenant_id AND ci.id = co.catalog_item_id
    JOIN inventory_locations il ON il.tenant_id = ii.tenant_id
    LEFT JOIN inventory_balances b ON b.tenant_id = ii.tenant_id AND b.location_id = il.id
      AND b.product_id = ii.catalog_item_id AND b.inventory_kind = 'sellable_catalog'
      AND b.is_sellable = true AND b.quarantined_at IS NULL
    LEFT JOIN inventory_reorder_policies p ON p.tenant_id = ii.tenant_id AND p.location_id = il.id AND p.inventory_item_id = ii.id
    WHERE ii.tenant_id = ${tenantId}
      AND COALESCE(ci.is_woo_managed, false) = false
      AND COALESCE(ci.is_local_alavont, true) = true
      AND COALESCE(ci.metadata->>'safeOnlyDuplicate', 'false') <> 'true'
      AND COALESCE((ci.metadata->>'archived')::boolean, false) = false
    ORDER BY ii.id, il.id, co.id
    LIMIT 800
  `)).map((row): StockLocationRow => ({
    inventoryItemId: Number(row.inventoryItemId),
    productName: String(row.productName ?? "Item"),
    optionLabel: String(row.optionLabel ?? "Standard"),
    locationId: Number(row.locationId),
    locationName: String(row.locationName ?? "Location"),
    onHand: String(row.onHand ?? "0"),
    available: String(row.available ?? "0"),
    par: String(row.par ?? "0"),
    reorderPoint: String(row.reorderPoint ?? "0"),
    preferredReorderQuantity: String(row.preferredReorderQuantity ?? "0"),
    moq: String(row.moq ?? "0"),
    eligible: asBool(row.eligible),
  }));
}

async function buildReport(tenantId: number | undefined, query: Record<string, unknown>) {
  await ensureReportSchema();
  const filters = parseFilters(query);
  const [orders, shifts, users] = await Promise.all([
    tenantId == null
      ? db.select({ id: ordersTable.id, tenantId: ordersTable.tenantId, createdAt: ordersTable.createdAt, assignedCsrUserId: ordersTable.assignedCsrUserId, paymentMethod: ordersTable.paymentMethod, paymentStatus: ordersTable.paymentStatus, total: ordersTable.total }).from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(500)
      : db.select({ id: ordersTable.id, tenantId: ordersTable.tenantId, createdAt: ordersTable.createdAt, assignedCsrUserId: ordersTable.assignedCsrUserId, paymentMethod: ordersTable.paymentMethod, paymentStatus: ordersTable.paymentStatus, total: ordersTable.total }).from(ordersTable).where(eq(ordersTable.tenantId, tenantId)).orderBy(desc(ordersTable.createdAt)).limit(500),
    tenantId == null
      ? db.select({ id: labTechShiftsTable.id, tenantId: labTechShiftsTable.tenantId, createdAt: labTechShiftsTable.createdAt, techId: labTechShiftsTable.techId, status: labTechShiftsTable.status, clockedInAt: labTechShiftsTable.clockedInAt, clockedOutAt: labTechShiftsTable.clockedOutAt, summary: labTechShiftsTable.summary, differenceAmount: labTechShiftsTable.differenceAmount, depositAmount: labTechShiftsTable.depositAmount }).from(labTechShiftsTable).orderBy(desc(labTechShiftsTable.createdAt)).limit(200)
      : db.select({ id: labTechShiftsTable.id, tenantId: labTechShiftsTable.tenantId, createdAt: labTechShiftsTable.createdAt, techId: labTechShiftsTable.techId, status: labTechShiftsTable.status, clockedInAt: labTechShiftsTable.clockedInAt, clockedOutAt: labTechShiftsTable.clockedOutAt, summary: labTechShiftsTable.summary, differenceAmount: labTechShiftsTable.differenceAmount, depositAmount: labTechShiftsTable.depositAmount }).from(labTechShiftsTable).where(eq(labTechShiftsTable.tenantId, tenantId)).orderBy(desc(labTechShiftsTable.createdAt)).limit(200),
    tenantId == null
      ? db.select({ id: usersTable.id, tenantId: usersTable.tenantId, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email }).from(usersTable)
      : db.select({ id: usersTable.id, tenantId: usersTable.tenantId, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email }).from(usersTable).where(eq(usersTable.tenantId, tenantId)),
  ]);
  // Order items have no tenant column. Resolve their IDs only through orders
  // already selected in the authenticated tenant scope.
  const orderIds = orders.map((order) => order.id);
  const items = orderIds.length
    ? await db.select({ orderId: orderItemsTable.orderId, catalogItemName: orderItemsTable.catalogItemName, quantity: orderItemsTable.quantity, totalPrice: orderItemsTable.totalPrice, createdAt: orderItemsTable.createdAt }).from(orderItemsTable).where(inArray(orderItemsTable.orderId, orderIds)).orderBy(desc(orderItemsTable.createdAt)).limit(2000)
    : [];

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
  const hours = emptyHours();
  const weekdays = emptyWeekdays();
  const byCsr = new Map<string, { id: number | null; name: string; orders: number; revenue: number }>();
  for (const order of filteredOrders) {
    const createdAt = new Date(order.createdAt);
    const hour = hours[hourInBusinessZone(createdAt)]!;
    const weekday = weekdays[weekdayInBusinessZone(createdAt)]!;
    hour.orders += 1;
    weekday.orders += 1;
    if (order.paymentStatus === "paid") {
      const paid = money(order.total);
      hour.revenue += paid;
      weekday.revenue += paid;
    }
    const csrKey = order.assignedCsrUserId == null ? "none" : String(order.assignedCsrUserId);
    const csr = byCsr.get(csrKey) ?? {
      id: order.assignedCsrUserId,
      name: order.assignedCsrUserId == null ? "Unassigned" : personName(usersById.get(order.assignedCsrUserId), order.assignedCsrUserId),
      orders: 0,
      revenue: 0,
    };
    csr.orders += 1;
    if (order.paymentStatus === "paid") csr.revenue += money(order.total);
    byCsr.set(csrKey, csr);
  }
  const csrIds = new Set<number>();
  for (const order of orders) if (order.assignedCsrUserId != null) csrIds.add(order.assignedCsrUserId);
  for (const shift of shifts) if (shift.techId != null) csrIds.add(shift.techId);
  const stock = (await loadStockRows(tenantId)).filter((row) => {
    if (!filters.product) return true;
    return `${row.productName} ${row.optionLabel}`.toLowerCase().includes(filters.product);
  });
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
    salesByCsr: Array.from(byCsr.values()).sort((a, b) => b.revenue - a.revenue),
    hourOfDay: hours,
    weekdayTrend: weekdays,
    paymentTrend: Array.from(byPayment.values()).sort((a, b) => b.revenue - a.revenue),
    productPerformance: Array.from(byProduct.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 30),
    inventory: inventoryRollup(stock),
    inventoryLocations: stock.filter((row) => row.eligible).map((row) => ({
      product: row.optionLabel === "Standard" ? row.productName : `${row.productName} — ${row.optionLabel}`,
      location: row.locationName,
      onHand: row.onHand,
      available: row.available,
      par: row.par,
    })),
    suggestedOrder: suggestedOrderLines(stock),
    csrOptions: [...csrIds].map((id) => ({ id, name: personName(usersById.get(id), id) })).sort((a, b) => a.name.localeCompare(b.name)),
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

router.get("/admin/reports/summary", ...authChain, async (req, res): Promise<void> => {
  res.json(await buildReport(req.authorizedTenantId, req.query));
});

router.get("/admin/reports/export.csv", ...authChain, async (req, res): Promise<void> => {
  const report = await buildReport(req.authorizedTenantId, req.query);
  const lines = [
    ["section", "name", "count", "revenue"].map(csvEscape).join(","),
    ...report.salesTrend.map(row => ["sales_trend", row.date, row.orders, row.revenue].map(csvEscape).join(",")),
    ...report.salesByCsr.map(row => ["sales_csr", row.name, row.orders, row.revenue].map(csvEscape).join(",")),
    ...report.hourOfDay.map(row => ["hour_of_day", row.label, row.orders, row.revenue].map(csvEscape).join(",")),
    ...report.weekdayTrend.map(row => ["weekday", row.day, row.orders, row.revenue].map(csvEscape).join(",")),
    ...report.paymentTrend.map(row => ["payment", row.method, row.orders, row.revenue].map(csvEscape).join(",")),
    ...report.productPerformance.map(row => ["product", row.name, row.quantity, row.revenue].map(csvEscape).join(",")),
    ...report.inventory.map(row => ["inventory", row.name, row.available, row.onHand].map(csvEscape).join(",")),
    ...report.suggestedOrder.map(row => ["suggested_order", `${row.product} @ ${row.location}`, row.orderQuantity, row.transfer].map(csvEscape).join(",")),
    ...report.workforce.map(row => ["workforce", `${row.name} shift ${row.shiftId}`, row.orderCount, row.revenue].map(csvEscape).join(",")),
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"myorder-reports.csv\"");
  res.send(`${lines.join("\n")}\n`);
});

export async function salesTaxReport(tenantId: number, query: Record<string, unknown>) {
  const from = typeof query.dateFrom === "string" ? new Date(`${query.dateFrom}T00:00:00.000Z`) : new Date("1970-01-01T00:00:00.000Z");
  const to = typeof query.dateTo === "string" ? new Date(`${query.dateTo}T23:59:59.999Z`) : new Date();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw Object.assign(new Error("Invalid reporting date range"), { status: 400 });
  const locationId = typeof query.locationId === "string" && query.locationId ? Number(query.locationId) : null;
  const rows = await db.select({ order: ordersTable, tax: orderTaxSnapshotsTable }).from(ordersTable).innerJoin(orderTaxSnapshotsTable, and(eq(orderTaxSnapshotsTable.tenantId, ordersTable.tenantId), eq(orderTaxSnapshotsTable.orderId, ordersTable.id))).where(and(
    eq(ordersTable.tenantId, tenantId), gte(ordersTable.createdAt, from), lte(ordersTable.createdAt, to),
    locationId ? eq(orderTaxSnapshotsTable.locationId, locationId) : undefined,
  ));
  // Tax snapshots preserve original collected tax. Refund tax is an append-only
  // sum of completed return records rather than a mutation of that snapshot.
  const refundRows = rows.length ? await db.execute(sql`SELECT rt.order_id, COALESCE(sum(rt.tax_amount),0)::numeric AS refunded
    FROM return_transactions rt JOIN orders o ON o.tenant_id=rt.tenant_id AND o.id=rt.order_id
    WHERE rt.tenant_id=${tenantId} AND rt.status='completed' AND o.created_at >= ${from} AND o.created_at <= ${to}
    ${locationId ? sql`AND EXISTS (SELECT 1 FROM order_tax_snapshots ots WHERE ots.tenant_id=rt.tenant_id AND ots.order_id=rt.order_id AND ots.location_id=${locationId})` : sql``}
    GROUP BY rt.order_id`) : { rows: [] };
  const refundedTaxByOrder = new Map((refundRows.rows as Array<{ order_id: number; refunded: string }>).map(row => [Number(row.order_id), Number(row.refunded)]));
  return buildSalesTaxReportFromRows(rows.filter(({ order }) => ["paid", "refunded", "partially_refunded"].includes(order.paymentStatus)).map(({ order, tax }) => ({
    id: order.id, total: money(order.total), grossSales: money(tax.grossSales), discounts: money(tax.discountAmount), taxableSales: money(tax.taxableSubtotal), nonTaxableSales: money(tax.nonTaxableSubtotal),
    taxCalculated: money(tax.taxCalculated), taxCollected: money(tax.taxCollected), taxRefunded: refundedTaxByOrder.get(order.id) ?? 0, jurisdiction: tax.jurisdiction ?? "UNSPECIFIED", taxRate: money(tax.taxRate),
    paymentMethod: order.paymentMethod ?? "unknown", customerCreditApplied: money(order.customerCreditApplied), voided: Boolean(order.voidedAt), refundAmount: order.paymentStatus === "refunded" ? money(order.total) : 0,
  })));
}

router.get("/admin/reports/sales-tax", ...authChain, async (req, res): Promise<void> => {
  try { res.json(await salesTaxReport(req.dbUser!.tenantId!, req.query)); }
  catch (error) { res.status((error as { status?: number }).status ?? 500).json({ error: (error as Error).message }); }
});

router.get("/admin/reports/sales-tax.csv", ...authChain, async (req, res): Promise<void> => {
  try {
    const report = await salesTaxReport(req.dbUser!.tenantId!, req.query);
    const lines = [["order_id", "payment_method", "total", "tax_calculated", "tax_collected", "tax_refunded"].join(","), ...report.transactions.map(row => [row.orderId, row.paymentMethod, row.total.toFixed(2), row.taxCalculated.toFixed(2), row.taxCollected.toFixed(2), row.taxRefunded.toFixed(2)].map(csvEscape).join(","))];
    res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Content-Disposition", "attachment; filename=\"sales-tax-detail.csv\""); res.send(`${lines.join("\n")}\n`);
  } catch (error) { res.status((error as { status?: number }).status ?? 500).json({ error: (error as Error).message }); }
});

export default router;
