import { Router, type IRouter } from "express";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { z } from "zod";
import { db, catalogItemsTable, tenantsTable, tenantSettingsTable } from "@workspace/db";
import { normalizeStorefrontHost, resolvePublicStorefrontTenantIdForHost } from "../config/publicStorefrontBranding";

const router: IRouter = Router();

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(24).default(12),
  category: z.string().trim().max(120).optional(),
  search: z.string().trim().max(100).optional(),
}).strict();

const publicItemSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  price: z.number().finite().nonnegative(),
  compareAtPrice: z.number().finite().nonnegative().nullable(),
  imageUrl: z.string().nullable(),
  isFeatured: z.boolean(),
}).strict();

const publicPageSchema = z.object({
  items: z.array(publicItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  categories: z.array(z.string()),
}).strict();

function safeImageUrl(value: string | null): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  if (candidate.startsWith("/") && !candidate.startsWith("//")) return candidate;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function isPublished(row: { metadata: unknown }): boolean {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
  return metadata.isVisible !== false
    && metadata.archived !== true
    && metadata.safeOnlyDuplicate !== true
    && metadata.mergedIntoCatalogItemId == null
    && metadata.complianceHold !== true;
}

async function tenantForPublicHost(host: string): Promise<number | null> {
  const records = await db.select({
    tenantId: tenantsTable.id,
    storefrontUrl: tenantSettingsTable.storefrontUrl,
    status: tenantsTable.status,
  }).from(tenantsTable).leftJoin(tenantSettingsTable, eq(tenantSettingsTable.tenantId, tenantsTable.id));
  const active = records.filter(record => record.status === "active");
  const configured = resolvePublicStorefrontTenantIdForHost(host, active.map(record => ({
    ...record, settings: null, publicBusinessName: null, businessDescription: null,
  })));
  if (configured) return configured;
  // The original myorder.fun deployment is single-tenant. A missing URL
  // configuration can resolve only when exactly one active tenant exists.
  return host === "myorder.fun" && active.length === 1 ? active[0].tenantId : null;
}

/** A guest-only projection of published Lucifer Cruz storefront products. */
router.get("/public/catalog", async (req, res): Promise<void> => {
  const host = normalizeStorefrontHost(req.headers.host);
  const query = querySchema.safeParse(req.query);
  if (!host || !query.success) {
    res.status(400).setHeader("Cache-Control", "no-store").json({ error: "Invalid catalog request" });
    return;
  }
  const tenantId = await tenantForPublicHost(host);
  if (!tenantId) {
    res.status(404).setHeader("Cache-Control", "no-store").json({ error: "Storefront not configured" });
    return;
  }

  const rows = await db.select({
    id: catalogItemsTable.id,
    luciferCruzName: catalogItemsTable.luciferCruzName,
    luciferCruzDescription: catalogItemsTable.luciferCruzDescription,
    luciferCruzCategory: catalogItemsTable.luciferCruzCategory,
    luciferCruzImageUrl: catalogItemsTable.luciferCruzImageUrl,
    name: catalogItemsTable.name,
    description: catalogItemsTable.description,
    category: catalogItemsTable.category,
    imageUrl: catalogItemsTable.imageUrl,
    price: catalogItemsTable.price,
    compareAtPrice: catalogItemsTable.compareAtPrice,
    isFeatured: catalogItemsTable.isFeatured,
    metadata: catalogItemsTable.metadata,
  }).from(catalogItemsTable).where(and(
    eq(catalogItemsTable.tenantId, tenantId),
    eq(catalogItemsTable.isWooManaged, true),
    eq(catalogItemsTable.merchantProductSource, "woo"),
    eq(catalogItemsTable.isAvailable, true),
    isNotNull(catalogItemsTable.wooProductId),
    ne(catalogItemsTable.wooProductId, ""),
  ));

  // The query selects only presentation fields. Routing and inventory data
  // remain server-side even while filtering requires a Woo product identity.
  const visible = rows.filter(isPublished);
  const categories = [...new Set(visible.map(row => (row.luciferCruzCategory || row.category).trim()).filter(Boolean))].sort();
  let filtered = visible;
  if (query.data.category) filtered = filtered.filter(row => (row.luciferCruzCategory || row.category) === query.data.category);
  if (query.data.search) {
    const search = query.data.search.toLocaleLowerCase();
    filtered = filtered.filter(row => (row.luciferCruzName || row.name).toLocaleLowerCase().includes(search));
  }
  filtered.sort((a, b) => Number(b.isFeatured) - Number(a.isFeatured) || (a.luciferCruzName || a.name).localeCompare(b.luciferCruzName || b.name));
  const { page, limit } = query.data;
  const items = filtered.slice((page - 1) * limit, page * limit).map(row => ({
    id: row.id,
    name: (row.luciferCruzName || row.name).slice(0, 160),
    description: (row.luciferCruzDescription || row.description)?.slice(0, 2000) ?? null,
    category: (row.luciferCruzCategory || row.category).slice(0, 120),
    price: Number(row.price),
    compareAtPrice: row.compareAtPrice == null ? null : Number(row.compareAtPrice),
    imageUrl: safeImageUrl(row.luciferCruzImageUrl || row.imageUrl),
    isFeatured: row.isFeatured === true,
  }));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Host");
  res.json(publicPageSchema.parse({ items, total: filtered.length, page, limit, categories }));
});

export default router;
