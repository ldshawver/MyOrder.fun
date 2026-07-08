import { Router, type IRouter } from "express";
import { and, eq, asc, sql } from "drizzle-orm";
import { z } from "zod";
import { db, adminSettingsTable, catalogItemsTable, inventoryTemplatesTable, inventoryBalancesTable, inventoryLocationsTable, orderItemsTable } from "@workspace/db";
import {
  ListCatalogItemsQueryParams,
  ListCatalogItemsResponse,
  CreateCatalogItemBody,
  GetCatalogItemParams,
  GetCatalogItemResponse,
  UpdateCatalogItemParams,
  UpdateCatalogItemBody,
  UpdateCatalogItemResponse,
  DeleteCatalogItemParams,
  ListCatalogCategoriesResponse,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved, normalizeRole, writeAuditLog } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

type CatalogMedia = { type: "image" | "video"; src: string; alt?: string | null };
const catalogDisplayUpdateSchema = z.object({
  displayName: z.string().trim().max(160).nullable().optional(),
  displayDescription: z.string().trim().max(4000).nullable().optional(),
  displayImage: z.string().trim().url().nullable().optional(),
  promoBadges: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  isFeatured: z.boolean().optional(),
  displayCategory: z.string().trim().max(120).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  visibleQuantityLabel: z.string().trim().max(80).nullable().optional(),
  catalogSectionLayout: z.enum(["grid", "carousel", "stack"]).optional(),
  isVisible: z.boolean().optional(),
}).strict();


function isArchivedOrSafeDuplicateRow(row: { metadata?: unknown }): boolean {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {};
  return metadata.archived === true || metadata.safeOnlyDuplicate === true || metadata.mergedIntoCatalogItemId != null;
}

function activeProductRows<T extends { metadata?: unknown }>(rows: T[]): T[] {
  return rows.filter(row => !isArchivedOrSafeDuplicateRow(row));
}

async function archiveSafeDuplicateRows(tenantId: number, actor: { id: number; email: string; role: string } | null, reason = "safe_duplicate_cleanup") {
  const rows = await db.select().from(catalogItemsTable).where(eq(catalogItemsTable.tenantId, tenantId));
  const activeParents = rows.filter(row => !isArchivedOrSafeDuplicateRow(row) && row.isWooManaged !== true && row.isLocalAlavont !== false);
  let merged = 0;
  const archivedIds: number[] = [];

  for (const candidate of rows) {
    if (isArchivedOrSafeDuplicateRow(candidate) || candidate.isWooManaged === true) continue;
    const metadata = candidate.metadata && typeof candidate.metadata === "object" && !Array.isArray(candidate.metadata) ? candidate.metadata as Record<string, unknown> : {};
    const hasAlavontIdentity = Boolean(candidate.alavontName?.trim() || candidate.alavontId?.trim());
    const looksSafeOnly = candidate.isLocalAlavont === false || candidate.merchantBrand === "lucifer_cruz" || (metadata.safeOnly === true) || (!hasAlavontIdentity && Boolean(candidate.luciferCruzName?.trim() || candidate.merchantName?.trim()));
    if (!looksSafeOnly) continue;

    const customerSafeName = (candidate.luciferCruzName || candidate.merchantName || candidate.customerSafeName || candidate.name || "").trim().toLowerCase();
    if (!customerSafeName) continue;
    const parent = activeParents.find(row => row.id !== candidate.id && [row.luciferCruzName, row.merchantName, row.customerSafeName].some(value => value?.trim().toLowerCase() === customerSafeName));
    if (!parent) continue;

    const parentMetadata = parent.metadata && typeof parent.metadata === "object" && !Array.isArray(parent.metadata) ? parent.metadata as Record<string, unknown> : {};
    await db.update(catalogItemsTable).set({
      luciferCruzName: parent.luciferCruzName ?? candidate.luciferCruzName ?? candidate.merchantName ?? candidate.name,
      luciferCruzDescription: parent.luciferCruzDescription ?? candidate.luciferCruzDescription ?? candidate.merchantDescription ?? candidate.description,
      luciferCruzCategory: parent.luciferCruzCategory ?? candidate.luciferCruzCategory ?? candidate.merchantCategory ?? candidate.category,
      luciferCruzImageUrl: parent.luciferCruzImageUrl ?? candidate.luciferCruzImageUrl ?? candidate.merchantImage ?? candidate.imageUrl,
      merchantName: parent.merchantName ?? candidate.merchantName ?? candidate.luciferCruzName,
      merchantDescription: parent.merchantDescription ?? candidate.merchantDescription ?? candidate.luciferCruzDescription,
      merchantCategory: parent.merchantCategory ?? candidate.merchantCategory ?? candidate.luciferCruzCategory,
      merchantImage: parent.merchantImage ?? candidate.merchantImage ?? candidate.luciferCruzImageUrl,
      receiptName: parent.receiptName ?? candidate.receiptName ?? candidate.luciferCruzName ?? candidate.name,
      labelName: parent.labelName ?? candidate.labelName ?? candidate.luciferCruzName ?? candidate.name,
      metadata: { ...parentMetadata, safeDuplicateMergedFrom: [...(Array.isArray(parentMetadata.safeDuplicateMergedFrom) ? parentMetadata.safeDuplicateMergedFrom : []), candidate.id] },
      updatedAt: new Date(),
    }).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, parent.id)));

    await db.update(catalogItemsTable).set({
      isAvailable: false,
      alavontInStock: false,
      isLocalAlavont: false,
      metadata: { ...metadata, archived: true, safeOnlyDuplicate: true, mergedIntoCatalogItemId: parent.id, lifecycleReason: reason },
      updatedAt: new Date(),
    }).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, candidate.id)));
    archivedIds.push(candidate.id);
    merged++;
  }

  if (actor && merged > 0) {
    await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: "catalog.safe_duplicates_merged", tenantId, resourceType: "catalog_item", metadata: { merged, archivedIds, reason } });
  }
  return { merged, archivedIds };
}

function safeMetadataPatch(current: unknown, patch: Record<string, unknown>) {
  const base = current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : {};
  return { ...base, presentation: { ...(base.presentation && typeof base.presentation === "object" && !Array.isArray(base.presentation) ? base.presentation as Record<string, unknown> : {}), ...patch } };
}

let catalogRouteSchemaEnsured = false;

async function ensureCatalogRouteSchema(): Promise<void> {
  if (catalogRouteSchemaEnsured) return;
  const statements = [
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "compare_at_price" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "stock_quantity" numeric(10, 2) DEFAULT 0`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "internal_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "internal_description" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "internal_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "supplier_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "supplier_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "backend_inventory_notes" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "vendor_sku" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "source_inventory_id" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "cost_basis" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "inventory_tracking_data" jsonb DEFAULT '{}'::jsonb`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "media_gallery" jsonb DEFAULT '[]'::jsonb`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "tags" text[] DEFAULT ARRAY[]::text[]`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_featured" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_sale_featured" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "regular_price" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "homie_price" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_description" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_image_url" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_in_stock" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_is_upsell" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_is_sample" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_id" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_created_date" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_updated_date" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_created_by_id" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_created_by" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_image_url" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_description" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lucifer_cruz_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_description" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "display_image" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_brand_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "marketing_copy" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "customer_safe_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "customer_safe_description" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "upsell_copy" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "promo_badges" text[] DEFAULT ARRAY[]::text[]`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_processing_mode" text DEFAULT 'mapped_lucifer'`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_product_source" text DEFAULT 'local_mapped'`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_woo_managed" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_local_alavont" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "woo_product_id" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "woo_variation_id" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "receipt_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "label_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lab_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "stock_unit" text DEFAULT '#'`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "par_level" numeric(10, 2) DEFAULT 0`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "external_menu_id" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "inventory_amount" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "unit_measurement" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_image" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_description" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_sku" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_brand" text NOT NULL DEFAULT 'alavont'`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "catalog_item_id" integer`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "alavont_id" text`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "deduction_quantity_per_sale" numeric(10, 3) DEFAULT 1`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "menu_price" numeric(10, 2)`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "payout_price" numeric(10, 2)`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "current_stock" numeric(10, 3)`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "par_level" numeric(10, 2) DEFAULT 0`,
  ];
  for (const statement of statements) {
    await db.execute(statement);
  }
  catalogRouteSchemaEnsured = true;
}

router.use(async (_req, res, next) => {
  try {
    await ensureCatalogRouteSchema();
    next();
  } catch {
    res.status(500).json({ error: "Could not prepare catalog schema" });
  }
});

function normalizeMediaGallery(raw: unknown, fallbackImage?: string | null): CatalogMedia[] {
  const gallery = Array.isArray(raw) ? raw : [];
  const normalized = gallery
    .map((entry): CatalogMedia | null => {
      if (typeof entry === "string") {
        const src = entry.trim();
        return src ? { type: "image", src } : null;
      }
      if (!entry || typeof entry !== "object") return null;
      const rec = entry as Record<string, unknown>;
      const src = typeof rec.src === "string" ? rec.src.trim() : "";
      if (!src) return null;
      const type = rec.type === "video" ? "video" : "image";
      return {
        type,
        src,
        alt: typeof rec.alt === "string" ? rec.alt : null,
      };
    })
    .filter((entry): entry is CatalogMedia => !!entry);
  const fallback = fallbackImage?.trim();
  if (fallback && !normalized.some((entry) => entry.src === fallback)) {
    normalized.unshift({ type: "image", src: fallback });
  }
  return normalized;
}

function mapItem(
  i: typeof catalogItemsTable.$inferSelect,
  alavontOnly = false,
  linkedInventoryStock?: number,
) {
  // Prefer alavont_image_url for the primary imageUrl; fall back to image_url
  const resolvedImageUrl = i.alavontImageUrl ?? i.imageUrl ?? undefined;
  const resolvedLuciferImageUrl = alavontOnly ? null : (i.luciferCruzImageUrl ?? i.imageUrl ?? null);
  const mediaGallery = normalizeMediaGallery(i.mediaGallery, alavontOnly ? resolvedImageUrl : (resolvedLuciferImageUrl ?? resolvedImageUrl));
  return {
    id: i.id,
    tenantId: i.tenantId,
    name: i.name,
    description: i.description,
    category: i.alavontCategory ?? i.category,
    sku: i.sku,
    price: parseFloat(i.price as string),
    compareAtPrice: i.compareAtPrice ? parseFloat(i.compareAtPrice as string) : undefined,
    stockQuantity: linkedInventoryStock ?? (i.stockQuantity != null ? parseFloat(String(i.stockQuantity)) : null),
    isAvailable: i.isAvailable,
    imageUrl: resolvedImageUrl,
    mediaGallery,
    tags: i.tags ?? [],
    metadata: i.metadata,
    isFeatured: i.isFeatured ?? false,
    isSaleFeatured: i.isSaleFeatured ?? false,
    internalName: i.internalName ?? null,
    internalDescription: i.internalDescription ?? null,
    internalCategory: i.internalCategory ?? null,
    supplierName: i.supplierName ?? null,
    supplierCategory: i.supplierCategory ?? null,
    backendInventoryNotes: i.backendInventoryNotes ?? null,
    vendorSku: i.vendorSku ?? null,
    sourceInventoryId: i.sourceInventoryId ?? null,
    costBasis: i.costBasis ? parseFloat(i.costBasis as string) : null,
    inventoryTrackingData: i.inventoryTrackingData ?? {},
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    // Dual-brand fields — LC merchant names suppressed in Alavont-only mode
    alavontName: i.alavontName ?? null,
    alavontDescription: i.alavontDescription ?? null,
    alavontCategory: i.alavontCategory ?? null,
    alavontImageUrl: i.alavontImageUrl ?? null,
    alavontInStock: i.alavontInStock ?? null,
    luciferCruzName: alavontOnly ? null : (i.luciferCruzName ?? null),
    luciferCruzImageUrl: resolvedLuciferImageUrl,
    luciferCruzDescription: alavontOnly ? null : (i.luciferCruzDescription ?? null),
    luciferCruzCategory: alavontOnly ? null : (i.luciferCruzCategory ?? null),
    displayName: i.displayName ?? null,
    displayDescription: i.displayDescription ?? null,
    displayCategory: i.displayCategory ?? null,
    displayImage: i.displayImage ?? null,
    merchantBrandName: alavontOnly ? null : (i.merchantBrandName ?? null),
    marketingCopy: alavontOnly ? null : (i.marketingCopy ?? null),
    customerSafeName: alavontOnly ? null : (i.customerSafeName ?? null),
    customerSafeDescription: alavontOnly ? null : (i.customerSafeDescription ?? null),
    upsellCopy: alavontOnly ? null : (i.upsellCopy ?? null),
    promoBadges: i.promoBadges ?? [],
    regularPrice: i.regularPrice ? parseFloat(i.regularPrice as string) : null,
    homiePrice: i.homiePrice ? parseFloat(i.homiePrice as string) : null,
    receiptName: alavontOnly ? null : (i.receiptName ?? null),
    labName: alavontOnly ? null : (i.labName ?? null),
    // Merchant routing fields — suppressed in Alavont-only (storefront) mode
    merchantProcessingMode: alavontOnly ? null : (i.merchantProcessingMode ?? null),
    merchantProductSource: alavontOnly ? null : (i.merchantProductSource ?? null),
    isWooManaged: alavontOnly ? false : (i.isWooManaged ?? false),
    isLocalAlavont: i.isLocalAlavont ?? true,
    wooProductId: alavontOnly ? null : (i.wooProductId ?? null),
    wooVariationId: alavontOnly ? null : (i.wooVariationId ?? null),
  };
}


function isLocalAlavontCatalogRow(row: typeof catalogItemsTable.$inferSelect): boolean {
  const name = String(row.alavontName ?? row.displayName ?? row.name ?? "").trim().toLowerCase();
  return row.isWooManaged !== true && row.isLocalAlavont !== false && !name.startsWith("safe");
}

async function syncCatalogItemToInventoryTemplate(row: typeof catalogItemsTable.$inferSelect): Promise<void> {
  if (!isLocalAlavontCatalogRow(row)) return;

  const stockValue = row.inventoryAmount ?? row.stockQuantity ?? "0";
  const itemName = row.alavontName ?? row.displayName ?? row.name;
  const patch = {
    sectionName: row.alavontCategory ?? row.category ?? "Alavont",
    itemName,
    rowType: "item",
    unitType: row.stockUnit ?? row.unitMeasurement ?? "#",
    startingQuantityDefault: String(stockValue ?? "0"),
    currentStock: String(stockValue ?? "0"),
    menuPrice: String(row.price ?? "0"),
    payoutPrice: String(row.price ?? "0"),
    isActive: row.isAvailable !== false,
    catalogItemId: row.id,
    alavontId: row.alavontId ?? row.externalMenuId ?? null,
    deductionQuantityPerSale: "1",
    parLevel: String(row.parLevel ?? "0"),
  };

  const [existing] = await db
    .select()
    .from(inventoryTemplatesTable)
    .where(
      and(
        eq(inventoryTemplatesTable.tenantId, row.tenantId),
        eq(inventoryTemplatesTable.catalogItemId, row.id),
      )
    )
    .limit(1);

  if (existing) {
    await db
      .update(inventoryTemplatesTable)
      .set(patch)
      .where(eq(inventoryTemplatesTable.id, existing.id));
    return;
  }

  const existingTemplates = await db
    .select({ displayOrder: inventoryTemplatesTable.displayOrder })
    .from(inventoryTemplatesTable)
    .where(eq(inventoryTemplatesTable.tenantId, row.tenantId));
  const nextDisplayOrder = existingTemplates.reduce((max, item) => Math.max(max, item.displayOrder ?? 0), 0) + 10;

  await db.insert(inventoryTemplatesTable).values({
    tenantId: row.tenantId,
    displayOrder: nextDisplayOrder,
    ...patch,
  });
}

async function getLinkedInventoryStockByCatalogId() {
  const templateRows = await db
    .select()
    .from(inventoryTemplatesTable)
    .where(eq(inventoryTemplatesTable.isActive, true));

  const stockByCatalogId = new Map<number, number>();
  for (const row of templateRows) {
    if (!row.catalogItemId || (row.rowType !== "item" && row.rowType !== "cash")) continue;

    const currentStock = row.currentStock != null
      ? parseFloat(String(row.currentStock))
      : parseFloat(String(row.startingQuantityDefault ?? 0));
    const deductPerSale = parseFloat(String(row.deductionQuantityPerSale ?? 1));
    const sellableUnits = deductPerSale > 0
      ? Math.floor(currentStock / deductPerSale)
      : Math.floor(currentStock);

    const existing = stockByCatalogId.get(row.catalogItemId);
    stockByCatalogId.set(row.catalogItemId, existing === undefined ? sellableUnits : Math.min(existing, sellableUnits));
  }

  return stockByCatalogId;
}

async function getShowOutOfStockSetting(): Promise<boolean> {
  try {
    const [settings] = await db
      .select({ showOutOfStock: adminSettingsTable.showOutOfStock })
      .from(adminSettingsTable)
      .limit(1);
    return settings?.showOutOfStock === true;
  } catch {
    return false;
  }
}

// GET /api/catalog
router.get("/catalog", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const query = ListCatalogItemsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const catalogMode = query.data.mode ?? "alavont";
  const isLuciferMode = catalogMode === "lucifer";
  // Admin users always receive full routing fields (isWooManaged, wooProductId,
  // merchantProcessingMode, luciferCruzName, etc.) regardless of mode — suppression is for
  // storefront/end-customer views only. This prevents catalog edits from accidentally
  // overwriting live routing config with suppressed null/false defaults.
  const actorRole = normalizeRole(actor.role);
  const isAdminActor = actorRole === "global_admin" || actorRole === "admin";
  const alavontOnly = !isLuciferMode && !isAdminActor;

  const tenantId = actor.tenantId ?? await getHouseTenantId();
  let rows = await db.select().from(catalogItemsTable)
    .where(eq(catalogItemsTable.tenantId, tenantId))
    .orderBy(asc(catalogItemsTable.name));

  rows = activeProductRows(rows);
  const totalBeforeFilters = rows.length;

  if (query.data.category) {
    const cat = query.data.category;
    rows = rows.filter(r => {
      const lcCat = (r.metadata as Record<string, unknown>)?.luciferCruzCategory;
      return r.luciferCruzCategory === cat || r.alavontCategory === cat || r.category === cat || lcCat === cat;
    });
  }
  if (query.data.search) {
    const s = query.data.search.toLowerCase();
    rows = rows.filter(r =>
      r.name.toLowerCase().includes(s) ||
      (r.description ?? "").toLowerCase().includes(s) ||
      (r.alavontName ?? "").toLowerCase().includes(s) ||
      (r.luciferCruzName ?? "").toLowerCase().includes(s) ||
      (r.labName ?? "").toLowerCase().includes(s)
    );
  }
  const showOutOfStock = await getShowOutOfStockSetting();
  if (query.data.available !== undefined) {
    rows = rows.filter(r => r.isAvailable === query.data.available);
  } else if (!isAdminActor && !showOutOfStock) {
    rows = rows.filter(r => r.isAvailable === true && r.alavontInStock !== false);
  }

  const page = query.data.page ?? 1;
  const limit = query.data.limit ?? 20;

  // Lucifer Cruz mode is the ecommerce storefront: only WooCommerce-synced
  // Lucifer Cruz products belong here. Alavont rows may have lucifer_cruz_*
  // mapping fields, but those are checkout/payment conversion fields, not
  // storefront membership.
  if (isLuciferMode) {
    rows = rows.filter(r => r.isWooManaged === true && r.merchantProductSource === "woo" && !!r.wooProductId);
  }

  // Alavont Therapeutics mode is the uploaded/imported vendor menu. It shows
  // local Alavont rows only, even though those rows carry Lucifer Cruz mapped
  // fields used later for merchant processing.
  // Admins see all non-WooCommerce rows (including imported items that may have
  // isLocalAlavont=false/null) so the inventory template dropdown is complete.
  if (!isLuciferMode) {
    if (isAdminActor) {
      rows = rows.filter(r => r.isWooManaged !== true);
    } else {
      rows = rows.filter(r => r.isLocalAlavont !== false && r.isWooManaged !== true);
    }
  }

  rows = rows.sort((a, b) => {
    const aRank = (a.isFeatured ? 0 : 2) + (a.isSaleFeatured || (a.compareAtPrice && Number(a.compareAtPrice) > Number(a.price)) ? 0 : 1);
    const bRank = (b.isFeatured ? 0 : 2) + (b.isSaleFeatured || (b.compareAtPrice && Number(b.compareAtPrice) > Number(b.price)) ? 0 : 1);
    if (aRank !== bRank) return aRank - bRank;
    return a.name.localeCompare(b.name);
  });

  const stockByCatalogId = await getLinkedInventoryStockByCatalogId();
  const total = rows.length;
  const paged = rows.slice((page - 1) * limit, page * limit);

  req.log.info(
    { catalogMode, totalInDb: totalBeforeFilters, afterFilters: total, returned: paged.length,
      category: query.data.category, search: query.data.search },
    "catalog list"
  );

  res.json(ListCatalogItemsResponse.parse({
    items: paged.map(i => mapItem(i, alavontOnly, stockByCatalogId.get(i.id))),
    total,
    page,
    limit,
  }));
});


// GET /api/admin/product-master — Edit Catalog Product Master view.
// Returns exactly the spreadsheet-backed fields plus current per-location balances.
router.get("/admin/product-master", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId();
  const [items, locations, balances] = await Promise.all([
    db.select().from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), sql`coalesce(${catalogItemsTable.isWooManaged}, false) = false`, sql`coalesce((${catalogItemsTable.metadata}->>'archived')::boolean, false) = false`, sql`coalesce((${catalogItemsTable.metadata}->>'safeOnlyDuplicate')::boolean, false) = false`)).orderBy(asc(catalogItemsTable.name)),
    db.select().from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.isActive, true))),
    db.select().from(inventoryBalancesTable).where(eq(inventoryBalancesTable.tenantId, tenantId)),
  ]);
  const locationNameById = new Map(locations.map(l => [l.id, l.name]));
  const qty = new Map<string, number>();
  for (const b of balances) qty.set(`${b.productId}:${locationNameById.get(b.locationId)}`, parseFloat(String(b.quantityOnHand ?? "0")));
  const rows = items.map(item => ({
    id: item.id,
    lifecycle: {
      active: item.isAvailable !== false,
      unavailable: item.isAvailable === false,
      archived: (item.metadata as Record<string, unknown> | null)?.archived === true,
      complianceHold: (item.metadata as Record<string, unknown> | null)?.complianceHold === true || item.alavontInStock === false,
      nonSellable: item.isAvailable === false || item.alavontInStock === false,
    },
    "Regular Price": item.regularPrice != null ? parseFloat(String(item.regularPrice)) : parseFloat(String(item.price ?? "0")),
    "Sale Price": item.compareAtPrice != null ? parseFloat(String(item.compareAtPrice)) : null,
    "Active Sale": item.compareAtPrice != null && String(item.price) === String(item.compareAtPrice),
    "Alavont Category": item.alavontCategory ?? item.category,
    "Alavont Name": item.alavontName ?? item.name,
    "Alavont Image": item.alavontImageUrl ?? item.imageUrl ?? null,
    "Alavont Description": item.alavontDescription ?? item.description ?? null,
    "Alavont SKU": item.alavontId ?? item.sku ?? item.merchantSku ?? null,
    "Safe Category": item.luciferCruzCategory ?? item.merchantCategory ?? null,
    "Safe Name": item.luciferCruzName ?? item.merchantName ?? null,
    "Safe Image": item.luciferCruzImageUrl ?? item.merchantImage ?? null,
    "Safe Description": item.luciferCruzDescription ?? item.merchantDescription ?? null,
    "Box 1 Inventory": qty.get(`${item.id}:Box 1`) ?? qty.get(`${item.id}:CSR Sales Box 1`) ?? 0,
    "Box 2 Inventory": qty.get(`${item.id}:Box 2`) ?? qty.get(`${item.id}:CSR Sales Box 2`) ?? 0,
    "Storefront Inventory": qty.get(`${item.id}:Storefront`) ?? 0,
    "Backstock Inventory": qty.get(`${item.id}:Backstock`) ?? 0,
  }));
  res.json({ rows, locations });
});

// PATCH /api/admin/product-master/:id/lifecycle — archive/reactivate/unavailable/compliance hold.
router.patch("/admin/product-master/:id/lifecycle", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid product id" }); return; }
  const body = z.object({
    active: z.boolean().optional(),
    archived: z.boolean().optional(),
    complianceHold: z.boolean().optional(),
    reason: z.string().trim().max(500).optional(),
  }).strict().safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const [existing] = await db.select().from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, id))).limit(1);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  const metadata = safeMetadataPatch(existing.metadata, {
    archived: body.data.archived ?? (existing.metadata as Record<string, unknown> | null)?.archived === true,
    complianceHold: body.data.complianceHold ?? (existing.metadata as Record<string, unknown> | null)?.complianceHold === true,
    lifecycleReason: body.data.reason ?? null,
  });
  const available = body.data.complianceHold === true || body.data.archived === true ? false : body.data.active ?? existing.isAvailable;
  const [updated] = await db.update(catalogItemsTable).set({ isAvailable: available, alavontInStock: available, metadata, updatedAt: new Date() }).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, id))).returning();
  await writeAuditLog({ actorId: req.dbUser!.id, actorEmail: req.dbUser!.email, actorRole: req.dbUser!.role, action: "catalog.lifecycle_updated", tenantId, resourceType: "catalog_item", resourceId: String(id), metadata: body.data, ipAddress: req.ip });
  res.json({ item: mapItem(updated ?? existing) });
});

// POST /api/catalog
router.post("/catalog", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  const body = CreateCatalogItemBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!body.data.name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const tenantId = await getHouseTenantId();
  // price is number in the Zod schema but string in the db schema (numeric precision);
  // use double-cast to satisfy drizzle's strict insert overloads
  const { costBasis, ...createData } = body.data;
  const [row] = await db.insert(catalogItemsTable).values({
    ...(createData as unknown as Partial<typeof catalogItemsTable.$inferInsert>),
    tenantId,
    name: body.data.name,
    alavontName: body.data.alavontName ?? body.data.name,
    alavontDescription: body.data.alavontDescription ?? body.data.description ?? null,
    alavontCategory: body.data.alavontCategory ?? body.data.category,
    alavontImageUrl: body.data.alavontImageUrl ?? body.data.imageUrl ?? null,
    alavontInStock: body.data.alavontInStock ?? body.data.isAvailable ?? true,
    merchantProcessingMode: body.data.merchantProcessingMode ?? "mapped_lucifer",
    merchantProductSource: body.data.merchantProductSource ?? "local_mapped",
    isWooManaged: body.data.isWooManaged ?? false,
    isLocalAlavont: true,
    merchantBrand: "alavont",
    price: String(body.data.price),
    compareAtPrice: body.data.compareAtPrice != null ? String(body.data.compareAtPrice) : undefined,
    costBasis: costBasis != null ? String(costBasis) : undefined,
    isAvailable: body.data.isAvailable ?? true,
    stockQuantity: String(body.data.stockQuantity ?? 0),
    inventoryAmount: String(body.data.stockQuantity ?? 0),
  } as unknown as typeof catalogItemsTable.$inferInsert).returning();
  await syncCatalogItemToInventoryTemplate(row);
  res.status(201).json(mapItem(row));
});

// GET /api/catalog/categories
router.get("/catalog/categories", async (req, res): Promise<void> => {
  const mode = req.query.mode === "lucifer" ? "lucifer" : "alavont";
  const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId();
  const rows = await db
    .select({
      alavontCategory: catalogItemsTable.alavontCategory,
      luciferCruzCategory: catalogItemsTable.luciferCruzCategory,
      category: catalogItemsTable.category,
      isWooManaged: catalogItemsTable.isWooManaged,
      isLocalAlavont: catalogItemsTable.isLocalAlavont,
      merchantProductSource: catalogItemsTable.merchantProductSource,
      wooProductId: catalogItemsTable.wooProductId,
      metadata: catalogItemsTable.metadata,
    })
    .from(catalogItemsTable)
    .where(eq(catalogItemsTable.tenantId, tenantId));

  const seen = new Set<string>();
  const categories: string[] = [];
  for (const r of activeProductRows(rows)) {
    if (mode === "lucifer") {
      if (r.isWooManaged !== true || r.merchantProductSource !== "woo" || !r.wooProductId) continue;
    } else if (r.isLocalAlavont === false || r.isWooManaged === true) {
      continue;
    }

    const cat = mode === "lucifer"
      ? (r.luciferCruzCategory || r.category)
      : (r.alavontCategory || r.category);
    if (cat && !seen.has(cat)) {
      seen.add(cat);
      categories.push(cat);
    }
  }
  categories.sort();
  res.json(ListCatalogCategoriesResponse.parse({ categories }));
});


// PATCH /api/catalog/:id/display - presentation-only visual editor fields.
router.patch("/catalog/:id/display", requireRole("global_admin", "admin", "tenant_admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid catalog item id" });
    return;
  }
  const body = catalogDisplayUpdateSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [existing] = await db.select().from(catalogItemsTable).where(eq(catalogItemsTable.id, id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (normalizeRole(req.dbUser?.role) !== "global_admin" && req.dbUser?.tenantId && existing.tenantId !== req.dbUser.tenantId) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const presentationPatch: Record<string, unknown> = {};
  if (body.data.sortOrder !== undefined) presentationPatch.sortOrder = body.data.sortOrder;
  if (body.data.visibleQuantityLabel !== undefined) presentationPatch.visibleQuantityLabel = body.data.visibleQuantityLabel;
  if (body.data.catalogSectionLayout !== undefined) presentationPatch.catalogSectionLayout = body.data.catalogSectionLayout;
  if (body.data.isVisible !== undefined) presentationPatch.isVisible = body.data.isVisible;
  const [updated] = await db.update(catalogItemsTable).set({
    displayName: body.data.displayName,
    displayDescription: body.data.displayDescription,
    displayImage: body.data.displayImage,
    promoBadges: body.data.promoBadges,
    isFeatured: body.data.isFeatured,
    displayCategory: body.data.displayCategory,
    metadata: Object.keys(presentationPatch).length ? safeMetadataPatch(existing.metadata, presentationPatch) : existing.metadata,
    updatedAt: new Date(),
  }).where(eq(catalogItemsTable.id, id)).returning();
  if (req.dbUser) {
    void writeAuditLog({ actorId: req.dbUser.id, actorEmail: req.dbUser.email, actorRole: req.dbUser.role, action: "catalog.display_updated", tenantId: existing.tenantId, resourceType: "catalog_item", resourceId: String(id), ipAddress: req.ip });
  }
  res.json({ item: mapItem(updated ?? existing) });
});

// GET /api/catalog/:id
router.get("/catalog/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetCatalogItemParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId();
  const [row] = await db.select().from(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, tenantId), eq(catalogItemsTable.id, params.data.id))).limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const actorRole = normalizeRole(req.dbUser?.role);
  const alavontOnly = actorRole !== "global_admin" && actorRole !== "admin";
  res.json(GetCatalogItemResponse.parse(mapItem(row, alavontOnly)));
});

// PATCH /api/catalog/:id
router.patch("/catalog/:id", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateCatalogItemParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateCatalogItemBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const houseTenantId = await getHouseTenantId();
  const [existing] = await db.select().from(catalogItemsTable)
    .where(and(eq(catalogItemsTable.tenantId, houseTenantId), eq(catalogItemsTable.id, params.data.id)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Compute merged state for conditional validation.
  // When null is sent for LC/Woo fields (common from Alavont-mode UI which suppresses them),
  // fall back to the existing DB value so validation doesn't reject standard catalog edits.
  const mergedIsWoo = body.data.isWooManaged ?? existing.isWooManaged;
  const mergedWooProductId = (body.data.wooProductId != null) ? body.data.wooProductId : existing.wooProductId;

  // Do not block ordinary catalog edits just because a legacy/imported row is
  // missing its Lucifer Cruz mapped name. The checkout normalizer still enforces
  // merchant-safe conversion before payment; admins must be able to repair the
  // customer-facing name/category/image/description/price first.
  if (mergedIsWoo && !mergedWooProductId) {
    res.status(400).json({
      error: "isWooManaged=true requires a wooProductId. Set the WooCommerce product ID before enabling Woo-managed mode.",
    });
    return;
  }

  const { price, compareAtPrice, stockQuantity, regularPrice, homiePrice, costBasis, ...restBodyData } = body.data;
  if (stockQuantity !== undefined) {
    res.status(409).json({ error: "inventory_balances mutation forbidden outside bootstrap-inventory, importer, and checkout deduction", use: "/api/admin/bootstrap-inventory" });
    return;
  }
  const updateData: Partial<typeof catalogItemsTable.$inferInsert> = restBodyData as Partial<typeof catalogItemsTable.$inferInsert>;
  if (price !== undefined) updateData.price = String(price);
  if (compareAtPrice !== undefined) updateData.compareAtPrice = compareAtPrice != null ? String(compareAtPrice) : null;
  if (regularPrice !== undefined) updateData.regularPrice = regularPrice != null ? String(regularPrice) : null;
  if (homiePrice !== undefined) updateData.homiePrice = homiePrice != null ? String(homiePrice) : null;
  if (costBasis !== undefined) updateData.costBasis = costBasis != null ? String(costBasis) : null;
  // Protect LC/Woo routing fields from null/false-overwrite.
  // Null values in the body (from Alavont-mode UI suppression) must not erase existing data.
  // isWooManaged: false must not downgrade a Woo-managed item without explicit intent.
  if (body.data.luciferCruzName === null && existing.luciferCruzName) delete updateData.luciferCruzName;
  if (body.data.luciferCruzImageUrl === null && existing.luciferCruzImageUrl) delete updateData.luciferCruzImageUrl;
  if (body.data.luciferCruzDescription === null && existing.luciferCruzDescription) delete updateData.luciferCruzDescription;
  if (body.data.luciferCruzCategory === null && existing.luciferCruzCategory) delete updateData.luciferCruzCategory;
  if (body.data.wooProductId === null && existing.wooProductId) delete updateData.wooProductId;
  if (body.data.wooVariationId === null && existing.wooVariationId) delete updateData.wooVariationId;
  if (body.data.merchantProcessingMode === null && existing.merchantProcessingMode) delete updateData.merchantProcessingMode;
  if (body.data.merchantProductSource === null && existing.merchantProductSource) delete updateData.merchantProductSource;
  // Prevent accidental isWooManaged downgrade: false in body when existing is true
  // requires an explicit merchantProcessingMode change in the same request to signal intent.
  if (body.data.isWooManaged === false && existing.isWooManaged === true) {
    if (!body.data.merchantProcessingMode || body.data.merchantProcessingMode === existing.merchantProcessingMode) {
      res.status(400).json({
        error: "Cannot disable isWooManaged without explicitly setting a new merchantProcessingMode. Provide both fields together to change routing mode.",
      });
      return;
    }
  }
  const [updated] = await db.update(catalogItemsTable)
    .set(updateData)
    .where(and(eq(catalogItemsTable.tenantId, houseTenantId), eq(catalogItemsTable.id, params.data.id)))
    .returning();
  const [fresh] = await db.select().from(catalogItemsTable)
    .where(and(eq(catalogItemsTable.tenantId, houseTenantId), eq(catalogItemsTable.id, params.data.id)))
    .limit(1);
  await syncCatalogItemToInventoryTemplate(fresh ?? updated);
  res.json(UpdateCatalogItemResponse.parse(mapItem(fresh ?? updated)));
});

// DELETE /api/catalog/:id
router.delete("/catalog/:id", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteCatalogItemParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const houseTenantId = await getHouseTenantId();
  const [existing] = await db.select().from(catalogItemsTable)
    .where(and(eq(catalogItemsTable.tenantId, houseTenantId), eq(catalogItemsTable.id, params.data.id)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [orderUse] = await db.select({ id: orderItemsTable.id }).from(orderItemsTable).where(eq(orderItemsTable.catalogItemId, params.data.id)).limit(1);
  const [balanceUse] = await db.select({ id: inventoryBalancesTable.id }).from(inventoryBalancesTable).where(and(eq(inventoryBalancesTable.tenantId, houseTenantId), eq(inventoryBalancesTable.productId, params.data.id))).limit(1);
  const [templateUse] = await db.select({ id: inventoryTemplatesTable.id }).from(inventoryTemplatesTable).where(and(eq(inventoryTemplatesTable.tenantId, houseTenantId), eq(inventoryTemplatesTable.catalogItemId, params.data.id))).limit(1);
  if (orderUse || balanceUse || templateUse) {
    const metadata = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata) ? existing.metadata as Record<string, unknown> : {};
    const [updated] = await db.update(catalogItemsTable).set({
      isAvailable: false,
      alavontInStock: false,
      metadata: { ...metadata, archived: true, lifecycleReason: "admin_delete_archive", archivedAt: new Date().toISOString() },
      updatedAt: new Date(),
    }).where(and(eq(catalogItemsTable.tenantId, houseTenantId), eq(catalogItemsTable.id, params.data.id))).returning();
    await writeAuditLog({ actorId: req.dbUser!.id, actorEmail: req.dbUser!.email, actorRole: req.dbUser!.role, action: "catalog.archived", tenantId: houseTenantId, resourceType: "catalog_item", resourceId: String(params.data.id), metadata: { reason: "delete_requested_with_history", hadOrderHistory: !!orderUse, hadInventory: !!balanceUse, hadTemplate: !!templateUse }, ipAddress: req.ip });
    res.json({ ok: true, mode: "archived", item: mapItem(updated ?? existing) });
    return;
  }
  await db.delete(catalogItemsTable).where(and(eq(catalogItemsTable.tenantId, houseTenantId), eq(catalogItemsTable.id, params.data.id)));
  await writeAuditLog({ actorId: req.dbUser!.id, actorEmail: req.dbUser!.email, actorRole: req.dbUser!.role, action: "catalog.deleted", tenantId: houseTenantId, resourceType: "catalog_item", resourceId: String(params.data.id), metadata: { reason: "delete_requested_no_history" }, ipAddress: req.ip });
  res.json({ ok: true, mode: "deleted", id: params.data.id });
});

router.post("/admin/product-master/cleanup-safe-duplicates", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId();
  const result = await archiveSafeDuplicateRows(tenantId, req.dbUser ? { id: req.dbUser.id, email: req.dbUser.email ?? "", role: req.dbUser.role } : null);
  res.json({ ok: true, ...result });
});

// ─── GET /api/admin/settings/diagnostics/catalog ────────────────────────────
// Returns a full diagnostic breakdown of catalog items and why some may be hidden.
router.get(
  "/admin/settings/diagnostics/catalog",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId();
    const allRows = await db.select().from(catalogItemsTable)
      .where(eq(catalogItemsTable.tenantId, tenantId))
      .orderBy(asc(catalogItemsTable.id));

    const analyzed = allRows.map(r => {
      const hasAlavontName = !!r.alavontName?.trim();
      const hasLCName = !!r.luciferCruzName?.trim();
      const hasLabName = !!r.labName?.trim();
      const hasPrice = !!(r.regularPrice || r.price);
      const hasCategory = !!(r.alavontCategory?.trim() || r.category?.trim());
      const hasImage = !!(r.alavontImageUrl || r.imageUrl);

      const missingFields: string[] = [];
      if (!hasAlavontName) missingFields.push("alavont_name");
      if (!hasLCName) missingFields.push("lucifer_cruz_name");
      if (!hasLabName) missingFields.push("lab_name");
      if (!hasPrice) missingFields.push("regular_price");
      if (!hasCategory) missingFields.push("alavont_category");

      const filteredBecause: string[] = [];
      if (!hasAlavontName) filteredBecause.push("missing alavont_name → hidden from Alavont catalog display");
      if (!hasLCName) filteredBecause.push("missing lucifer_cruz_name → hidden from Lucifer Cruz tab");
      if (r.isAvailable === false) filteredBecause.push("is_available=false");
      if (r.alavontInStock === false) filteredBecause.push("alavont_in_stock=false");

      return {
        id: r.id,
        tenantId: r.tenantId,
        name: r.name,
        alavontName: r.alavontName,
        alavontId: r.alavontId,
        regularPrice: r.regularPrice ? parseFloat(r.regularPrice as string) : null,
        alavontCategory: r.alavontCategory ?? r.category,
        alavontInStock: r.alavontInStock,
        luciferCruzName: r.luciferCruzName,
        luciferCruzCategory: r.luciferCruzCategory ?? (r.metadata as Record<string, unknown>)?.luciferCruzCategory ?? null,
        merchantProcessingMode: r.merchantProcessingMode ?? null,
        merchantProductSource: r.merchantProductSource ?? null,
        isWooManaged: r.isWooManaged,
        isLocalAlavont: r.isLocalAlavont,
        wooProductId: r.wooProductId ?? null,
        labName: r.labName,
        isAvailable: r.isAvailable,
        hasImage,
        alavontImageUrl: r.alavontImageUrl,
        imageUrl: r.imageUrl,
        missingFields,
        filteredBecause,
        visibleAlavont: hasAlavontName && r.isAvailable !== false,
        visibleLC: hasLCName && r.isAvailable !== false,
      };
    });

    const summary = {
      totalRows: allRows.length,
      visibleAlavont: analyzed.filter(r => r.visibleAlavont).length,
      visibleLC: analyzed.filter(r => r.visibleLC).length,
      hiddenUnavailable: analyzed.filter(r => r.isAvailable === false).length,
      hiddenMissingAlavontName: analyzed.filter(r => !r.alavontName?.trim()).length,
      hiddenMissingLCName: analyzed.filter(r => !r.luciferCruzName?.trim()).length,
      missingPrice: analyzed.filter(r => r.regularPrice === null).length,
      missingLabName: analyzed.filter(r => !r.labName?.trim()).length,
      missingImage: analyzed.filter(r => !r.hasImage).length,
      missingRequiredFields: analyzed.filter(r => r.missingFields.length > 0).length,
      categoryCounts: Object.entries(
        analyzed.reduce((acc, r) => {
          const cat = r.alavontCategory || "Uncategorized";
          acc[cat] = (acc[cat] || 0) + 1;
          return acc;
        }, {} as Record<string, number>)
      ).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    };

    req.log.info({ total: allRows.length, visibleAlavont: summary.visibleAlavont, visibleLC: summary.visibleLC }, "catalog diagnostics");

    res.json({ summary, items: analyzed });
  }
);

router.get("/admin/catalog/debug", requireRole("global_admin", "admin"), async (_req, res): Promise<void> => {
  res.status(404).json({ error: "Catalog Debug has moved to Admin Settings → Diagnostics" });
});

// ─── POST /api/admin/checkout/normalize-preview ───────────────────────────────
// Admin-only: Preview normalized cart from raw catalog item IDs
router.post(
  "/admin/checkout/normalize-preview",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    try {
      const { normalizeCheckoutCart } = await import("../lib/checkoutNormalizer");
      const { items } = req.body as { items?: Array<{ catalogItemId: number; quantity: number }> };
      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ error: "items array required" });
        return;
      }
      const normalized = await normalizeCheckoutCart(items);
      res.json({ normalized });
    } catch (err) {
      res.status(400).json({ error: (err as Error)?.message ?? "Normalization failed" });
    }
  }
);

// ─── POST /api/admin/checkout/merchant-payload-preview ────────────────────────
// Admin-only: Preview the merchant payload that would be sent to the processor
router.post(
  "/admin/checkout/merchant-payload-preview",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    try {
      const { normalizeCheckoutCart, buildMerchantPayloadLines } = await import("../lib/checkoutNormalizer");
      const { getOrCreateSettings } = await import("./settings");
      const { items } = req.body as { items?: Array<{ catalogItemId: number; quantity: number }> };
      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ error: "items array required" });
        return;
      }
      const settings = await getOrCreateSettings();
      const normalized = await normalizeCheckoutCart(items);
      const merchantLines = buildMerchantPayloadLines(normalized, settings.merchantImageEnabled);

      const alavontNamesInPayload = merchantLines.filter(l =>
        normalized.some(n => n.receipt_alavont_name === l.name && n.receipt_alavont_name !== n.receipt_lucifer_name)
      );

      res.json({
        merchant_lines: merchantLines,
        alavont_name_leak_detected: alavontNamesInPayload.length > 0,
        alavont_name_leaks: alavontNamesInPayload.map(l => l.name),
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error)?.message ?? "Preview failed" });
    }
  }
);

// ─── GET /api/admin/receipts/preview ─────────────────────────────────────────
// Admin-only: Preview a rendered receipt in a specific name mode.
// Returns the actual receipt text output (plain-text, 80-column formatted)
// so operators can see exactly what prints in each mode.
router.get(
  "/admin/receipts/preview",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const mode = (req.query.mode as string) ?? "lucifer_only";
    if (!["alavont_only", "lucifer_only", "both"].includes(mode)) {
      res.status(400).json({ error: "mode must be alavont_only, lucifer_only, or both" });
      return;
    }
    const typedMode = mode as "alavont_only" | "lucifer_only" | "both";

    const { renderCustomerReceipt } = await import("../lib/receiptRenderer");

    // Sample order with dual-brand items covering both local_mapped and woo sources
    const sampleOrder = {
      id: 0,
      orderNumber: "PREVIEW-001",
      customerName: "Preview Customer",
      fulfillmentType: "Pickup",
      paymentStatus: "paid",
      subtotal: 79.98,
      tax: 6.40,
      total: 86.38,
      createdAt: new Date().toISOString(),
      receiptLineNameMode: typedMode,
      dualBrandName: "Alavont / Lucifer Cruz",
      footerMessage: "Thank you for your order!",
      showDiscreetNotice: false,
      showOperatorName: true,
      operatorName: "Preview Operator",
      items: [
        {
          quantity: 2,
          name: "Sample Alavont Product",
          alavontName: "Sample Alavont Product",
          luciferCruzName: "Sample Lucifer Cruz Product",
          unitPrice: 29.99,
          totalPrice: 59.98,
        },
        {
          quantity: 1,
          name: "Woo Alavont Name",
          alavontName: "Woo Alavont Name",
          luciferCruzName: "Woo LC Merchant Name",
          unitPrice: 19.99,
          totalPrice: 19.99,
        },
      ],
    };

    const rendered = renderCustomerReceipt(sampleOrder);

    res.json({
      mode: typedMode,
      rendered_receipt: rendered,
      description: `Receipt preview in '${typedMode}' mode — this is the exact text sent to the printer`,
    });
  }
);

export default router;
