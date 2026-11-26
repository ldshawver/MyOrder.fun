import { Router, type IRouter } from "express";
import { and, asc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import { catalogItemsTable, db, tenantsTable, usersTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, writeAuditLog } from "../lib/auth";
import { publicCatalogEligibility } from "../lib/catalogEligibility";
import { logger } from "../lib/logger";
import { hasPermission, requirePermission } from "../lib/roles";
import { requireTenantContext } from "../lib/tenantContext";
import { SPEED_ORDER_PINS_KEY, SPEED_ORDER_RANK_WINDOW_DAYS, acceptSpeedOrderPins, parseSpeedOrderPins, selectHybridTopNine, speedOrderSellableItem, type RankedSale, type SpeedOrderCatalogItem, type SpeedOrderPin } from "../lib/speedOrderTopNine";

const router: IRouter = Router();
const catalogColumns = {
  id: catalogItemsTable.id, name: catalogItemsTable.name, displayName: catalogItemsTable.displayName,
  alavontName: catalogItemsTable.alavontName, imageUrl: catalogItemsTable.imageUrl, displayImage: catalogItemsTable.displayImage,
  alavontImageUrl: catalogItemsTable.alavontImageUrl, price: catalogItemsTable.price, regularPrice: catalogItemsTable.regularPrice,
  compareAtPrice: catalogItemsTable.compareAtPrice, metadata: catalogItemsTable.metadata, isAvailable: catalogItemsTable.isAvailable,
};
function rows<T>(result: unknown): T[] { return Array.isArray(result) ? result as T[] : ((result as { rows?: T[] } | undefined)?.rows ?? []); }
function settings(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

async function loadSellable(tenantId: number, ids: number[]): Promise<SpeedOrderCatalogItem[]> {
  if (!ids.length) return [];
  const found = await db.select(catalogColumns).from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), inArray(catalogItemsTable.id, ids), publicCatalogEligibility()));
  return found.flatMap(row => { const item = speedOrderSellableItem(row); return item ? [item] : []; });
}

async function paidUnitRankings(tenantId: number): Promise<RankedSale[]> {
  const result = rows<{ catalogItemId: number | string; units: number | string }>(await db.execute(sql`
    SELECT oi.catalog_item_id AS "catalogItemId", SUM(oi.quantity)::int AS units
    FROM order_items oi INNER JOIN orders o ON o.id = oi.order_id
    WHERE o.tenant_id = ${tenantId}
      AND o.created_at >= NOW() - (${SPEED_ORDER_RANK_WINDOW_DAYS} * INTERVAL '1 day')
      AND o.payment_status = 'paid'
      AND o.status NOT IN ('cancelled', 'voided', 'refunded')
      AND o.voided_at IS NULL AND o.cancelled_at IS NULL AND oi.quantity > 0
    GROUP BY oi.catalog_item_id ORDER BY units DESC, oi.catalog_item_id ASC LIMIT 40
  `));
  return result.flatMap(row => {
    const catalogItemId = Number(row.catalogItemId); const units = Number(row.units);
    return Number.isSafeInteger(catalogItemId) && catalogItemId > 0 && Number.isFinite(units) && units > 0 ? [{ catalogItemId, units }] : [];
  });
}

router.use("/speed-order", requireAuth, loadDbUser, requireDbUser, requireApproved, requireTenantContext);

router.get("/speed-order/top-nine", requirePermission("speed_order.use"), async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!;
  try {
    const [tenant] = await db.select({ settings: tenantsTable.settings }).from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
    if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
    const pins = parseSpeedOrderPins(settings(tenant.settings)[SPEED_ORDER_PINS_KEY]);
    const ranked = await paidUnitRankings(tenantId);
    const catalog = await loadSellable(tenantId, [...new Set([...pins.map(pin => pin.catalogItemId), ...ranked.map(row => row.catalogItemId)])]);
    res.json({ windowDays: SPEED_ORDER_RANK_WINDOW_DAYS, canPin: await hasPermission(req.dbUser!, "speed_order.pin", tenantId), slots: selectHybridTopNine({ ranked, pins, catalog }) });
  } catch (error) { logger.error({ error, tenantId }, "Speed Order top nine failed"); res.status(500).json({ error: "Could not load Speed Order" }); }
});

const browseEligible = (tenantId: number) => and(
  eq(catalogItemsTable.tenantId, tenantId),
  eq(catalogItemsTable.isAvailable, true),
  publicCatalogEligibility(),
);
const browseCategory = sql<string>`btrim(${catalogItemsTable.category})`;
const BROWSE_PAGE_SIZE = 40;

router.get("/speed-order/categories", requirePermission("speed_order.use"), async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!;
  res.set("Cache-Control", "no-store");
  try {
    const categories = await db.selectDistinct({ name: browseCategory }).from(catalogItemsTable)
      .where(browseEligible(tenantId)).orderBy(browseCategory);
    res.json({ categories: categories.map(category => category.name) });
  } catch (error) {
    logger.error({ error, tenantId }, "Speed Order categories failed");
    res.status(500).json({ error: "Could not load categories" });
  }
});

router.get("/speed-order/category-items", requirePermission("speed_order.use"), async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!;
  res.set("Cache-Control", "no-store");
  const { category, after = "0" } = req.query;
  if (Object.keys(req.query).some(key => key !== "category" && key !== "after")
    || typeof category !== "string" || category.length > 512
    || typeof after !== "string" || !/^\d{1,10}$/.test(after) || Number(after) > 2147483647) {
    res.status(400).json({ error: "Invalid category or page cursor" });
    return;
  }
  try {
    const found = await db.select(catalogColumns).from(catalogItemsTable).where(and(
      browseEligible(tenantId), eq(browseCategory, category), gt(catalogItemsTable.id, Number(after)),
    )).orderBy(asc(catalogItemsTable.id)).limit(BROWSE_PAGE_SIZE + 1);
    const page = found.slice(0, BROWSE_PAGE_SIZE);
    const items = page.flatMap(row => {
      const item = speedOrderSellableItem(row);
      return item ? [item] : [];
    });
    res.json({ items, nextCursor: found.length > BROWSE_PAGE_SIZE ? page.at(-1)?.id ?? null : null });
  } catch (error) {
    logger.error({ error, tenantId }, "Speed Order category items failed");
    res.status(500).json({ error: "Could not load category items" });
  }
});

router.get("/speed-order/catalog", requirePermission("speed_order.pin"), async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!;
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const pattern = `%${query.replace(/[\\%_]/g, "")}%`;
  try {
    const found = await db.select(catalogColumns).from(catalogItemsTable).where(and(
      eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.isAvailable, true), publicCatalogEligibility(),
      query ? or(ilike(catalogItemsTable.name, pattern), ilike(catalogItemsTable.displayName, pattern), ilike(catalogItemsTable.alavontName, pattern), ilike(catalogItemsTable.sku, pattern)) : undefined,
    )).orderBy(asc(catalogItemsTable.name)).limit(40);
    res.json({ items: found.flatMap(row => { const item = speedOrderSellableItem(row); return item ? [item] : []; }).slice(0, 20) });
  } catch (error) { logger.error({ error, tenantId }, "Speed Order catalog search failed"); res.status(500).json({ error: "Could not search the catalog" }); }
});

/**
 * Member selection is intentionally separate from checkout.  The endpoint
 * returns only eligible same-tenant members and never changes order
 * ownership; the later shared checkout call must still bind its capability to
 * the selected member rather than to the CSR actor.
 */
router.get("/speed-order/members", requirePermission("speed_order.use"), async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!;
  if (!(await hasPermission(req.dbUser!, "customers.view", tenantId))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (Object.keys(req.query).some(key => key !== "q")) {
    res.status(400).json({ error: "Invalid member search" });
    return;
  }
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const pattern = `%${query.replace(/[\\%_]/g, "")}%`;
  const members = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
    .from(usersTable)
    .where(and(
      eq(usersTable.tenantId, tenantId),
      eq(usersTable.status, "approved"),
      eq(usersTable.isActive, true),
      sql`lower(${usersTable.role}) IN ('user', 'customer')`,
      query ? or(ilike(usersTable.firstName, pattern), ilike(usersTable.lastName, pattern), ilike(usersTable.email, pattern)) : undefined,
    ))
    .orderBy(asc(usersTable.lastName), asc(usersTable.firstName), asc(usersTable.id))
    .limit(25);
  res.json({ members: members.map(member => ({
    id: member.id,
    name: [member.firstName, member.lastName].filter(Boolean).join(" ") || member.email || `Member ${member.id}`,
  })) });
});

router.put("/speed-order/pins", requirePermission("speed_order.pin"), async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!;
  const accepted = acceptSpeedOrderPins(req.body);
  if (!accepted.ok) { res.status(400).json({ error: accepted.error }); return; }
  try {
    const sellable = await loadSellable(tenantId, accepted.pins.map(pin => pin.catalogItemId));
    const available = new Set(sellable.map(item => item.id));
    if (accepted.pins.some(pin => !available.has(pin.catalogItemId))) { res.status(400).json({ error: "Catalog item is not available for this tenant" }); return; }
    const pins: SpeedOrderPin[] = accepted.pins;
    const updated = rows<{ id: number }>(await db.execute(sql`
      UPDATE tenants SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), ARRAY[${SPEED_ORDER_PINS_KEY}]::text[], ${JSON.stringify(pins)}::jsonb, true), updated_at = NOW()
      WHERE id = ${tenantId} RETURNING id
    `));
    if (!updated.length) { res.status(404).json({ error: "Tenant not found" }); return; }
    await writeAuditLog({ actorId: req.dbUser!.id, actorEmail: req.dbUser!.email, actorRole: req.dbUser!.role ?? "supervisor", tenantId, action: "speed_order.pins_updated", resourceType: "tenant", resourceId: String(tenantId), metadata: { pins }, ipAddress: req.ip });
    res.json({ pins });
  } catch (error) { logger.error({ error, tenantId }, "Speed Order pin update failed"); res.status(500).json({ error: "Could not save Speed Order pins" }); }
});

export default router;
