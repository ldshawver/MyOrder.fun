import { Router, type IRouter } from "express";
import { eq, count, sum, desc } from "drizzle-orm";
import { db, tenantsTable, ordersTable, catalogItemsTable, usersTable, orderItemsTable } from "@workspace/db";
import {
  ListTenantsResponse,
  GetTenantParams,
  GetTenantResponse,
  UpdateTenantParams,
  UpdateTenantBody,
  UpdateTenantResponse,
  GetTenantSummaryParams,
  GetTenantSummaryResponse,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireDbUser, requireRole, writeAuditLog } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser);

function mapTenant(t: typeof tenantsTable.$inferSelect) {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    status: t.status,
    plan: t.plan,
    contactEmail: t.contactEmail,
    settings: t.settings,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// GET /api/tenants
router.get("/tenants", requireRole("admin"), async (_req, res): Promise<void> => {
  const rows = await db.select().from(tenantsTable).orderBy(desc(tenantsTable.createdAt));
  res.json(ListTenantsResponse.parse({ tenants: rows.map(mapTenant), total: rows.length }));
});

// GET /api/tenants/:id
router.get("/tenants/:id", requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetTenantParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, params.data.id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json(GetTenantResponse.parse(mapTenant(row)));
});

// PATCH /api/tenants/:id
router.patch("/tenants/:id", requireRole("admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateTenantParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateTenantBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [existing] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, params.data.id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const [updated] = await db.update(tenantsTable).set(body.data).where(eq(tenantsTable.id, params.data.id)).returning();
  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "UPDATE_TENANT",
    resourceType: "tenant",
    resourceId: String(params.data.id),
    metadata: { changes: body.data },
    ipAddress: req.ip,
  });
  res.json(UpdateTenantResponse.parse(mapTenant(updated)));
});

// GET /api/tenants/:id/summary
router.get("/tenants/:id/summary", requireRole("admin", "supervisor", "business_sitter"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetTenantSummaryParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const tenantId = params.data.id;
  const orders = await db.select().from(ordersTable);
  const totalOrders = orders.length;
  const pendingOrders = orders.filter(o => o.status === "pending").length;
  const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total as string), 0);

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const revenueThisMonth = orders
    .filter(o => new Date(o.createdAt) >= startOfMonth)
    .reduce((s, o) => s + parseFloat(o.total as string), 0);

  const [{ count: productCount }] = await db.select({ count: count() }).from(catalogItemsTable);
  const [{ count: customerCount }] = await db.select({ count: count() }).from(usersTable);

  // Top 5 products by order count
  const items = await db.select().from(orderItemsTable)
    .innerJoin(ordersTable, eq(orderItemsTable.orderId, ordersTable.id));

  const productMap = new Map<number, { id: number; name: string; orderCount: number; revenue: number }>();
  for (const item of items) {
    const id = item.order_items.catalogItemId;
    const existing = productMap.get(id) ?? { id, name: item.order_items.catalogItemName, orderCount: 0, revenue: 0 };
    existing.orderCount += item.order_items.quantity;
    existing.revenue += parseFloat(item.order_items.totalPrice as string);
    productMap.set(id, existing);
  }
  const topProducts = [...productMap.values()].sort((a, b) => b.orderCount - a.orderCount).slice(0, 5);

  res.json(GetTenantSummaryResponse.parse({
    tenantId,
    totalOrders,
    pendingOrders,
    totalRevenue,
    revenueThisMonth,
    totalProducts: Number(productCount),
    totalCustomers: Number(customerCount),
    topProducts,
  }));
});

export default router;
