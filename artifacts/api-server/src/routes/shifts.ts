import { Router, type IRouter, type Request } from "express";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import {
  db,
  labTechShiftsTable,
  shiftInventoryItemsTable,
  inventoryTemplatesTable,
  catalogItemsTable,
  csrBoxesTable,
  ordersTable,
  orderItemsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved, writeAuditLog } from "../lib/auth";

// Roles permitted to operate a shift. Legacy role names are normalized in
// requireRole: sales_rep/lab_tech/business_sitter/lab_technician => CSR,
// supervisor => admin, customer => user.
const SHIFT_OPERATOR_ROLES = [
  "customer_service_rep",
  "admin",
  "global_admin",
] as const;
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

// Hardcoded seed defaults used only if the csr_boxes table is empty.
const DEFAULT_CSR_BOXES = [
  { slug: "sales-box-1", label: "CSR Sales Box 1", displayOrder: 1 },
  { slug: "sales-box-2", label: "CSR Sales Box 2", displayOrder: 2 },
];

let shiftSchemaEnsured = false;

async function ensureShiftSchema(): Promise<void> {
  if (shiftSchemaEnsured) return;
  const statements = [
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "box_assignment_id" text`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "setup_json" jsonb DEFAULT '{}'::jsonb`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "cash_bank_start" numeric(10, 2) DEFAULT 0`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "cash_bank_end" numeric(10, 2)`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "cash_bank_end_reported" numeric(10, 2)`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "tip_percent_selected" numeric(5, 2)`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "tip_amount" numeric(10, 2)`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "difference_amount" numeric(10, 2) DEFAULT 0`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "deposit_amount" numeric(10, 2)`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "supervisor_id" integer`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "supervisor_confirmed_at" timestamp with time zone`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "payment_totals_json" json`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "summary" json`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL`,
    sql`ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "catalog_item_id" integer`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "alavont_id" text`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "deduction_unit_output" text DEFAULT '#'`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "deduction_quantity_per_sale" numeric(10, 3) DEFAULT 1`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "menu_price" numeric(10, 2)`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "payout_price" numeric(10, 2)`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "current_stock" numeric(10, 3)`,
    sql`ALTER TABLE "inventory_templates" ADD COLUMN IF NOT EXISTS "par_level" numeric(10, 2) DEFAULT 0`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "stock_quantity" numeric(10, 2) DEFAULT 0`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "stock_unit" text DEFAULT '#'`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "par_level" numeric(10, 2) DEFAULT 0`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "media_gallery" jsonb DEFAULT '[]'::jsonb`,
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
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "compare_at_price" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "tags" text[] DEFAULT ARRAY[]::text[]`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_featured" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_sale_featured" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "regular_price" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "homie_price" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_id" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_description" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_image_url" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_in_stock" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_is_upsell" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "alavont_is_sample" boolean NOT NULL DEFAULT false`,
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
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "external_menu_id" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "inventory_amount" numeric(10, 2)`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "unit_measurement" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_image" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_description" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_category" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_sku" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_brand" text NOT NULL DEFAULT 'alavont'`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_processing_mode" text DEFAULT 'mapped_lucifer'`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "merchant_product_source" text DEFAULT 'local_mapped'`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_woo_managed" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "is_local_alavont" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "woo_product_id" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "woo_variation_id" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "receipt_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "label_name" text`,
    sql`ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "lab_name" text`,
    sql`ALTER TABLE "shift_inventory_items" ADD COLUMN IF NOT EXISTS "template_item_id" integer`,
    sql`ALTER TABLE "shift_inventory_items" ADD COLUMN IF NOT EXISTS "section_name" text`,
    sql`ALTER TABLE "shift_inventory_items" ADD COLUMN IF NOT EXISTS "row_output" text DEFAULT 'item'`,
    sql`ALTER TABLE "shift_inventory_items" ADD COLUMN IF NOT EXISTS "unit_output" text DEFAULT '#'`,
    sql`ALTER TABLE "shift_inventory_items" ADD COLUMN IF NOT EXISTS "display_order" integer DEFAULT 0`,
    sql`ALTER TABLE "shift_inventory_items" ADD COLUMN IF NOT EXISTS "quantity_sold" numeric(10, 3) DEFAULT 0`,
    sql`ALTER TABLE "shift_inventory_items" ADD COLUMN IF NOT EXISTS "quantity_end" numeric(10, 3)`,
    sql`ALTER TABLE "shift_inventory_items" ADD COLUMN IF NOT EXISTS "quantity_end_actual" numeric(10, 3)`,
    sql`ALTER TABLE "shift_inventory_items" ADD COLUMN IF NOT EXISTS "discrepancy" numeric(10, 3)`,
    sql`ALTER TABLE "shift_inventory_items" ADD COLUMN IF NOT EXISTS "is_flagged" boolean DEFAULT false`,
    // csr_boxes — tenant-scoped physical/logical sales boxes
    sql`CREATE TABLE IF NOT EXISTS "csr_boxes" (
      "id" serial PRIMARY KEY,
      "tenant_id" integer NOT NULL,
      "slug" text NOT NULL,
      "label" text NOT NULL,
      "description" text,
      "location" text,
      "is_active" boolean NOT NULL DEFAULT true,
      "display_order" integer NOT NULL DEFAULT 0,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )`,
  ];
  for (const statement of statements) {
    await db.execute(statement);
  }
  // Seed default boxes if the table is empty for this tenant
  const houseTenantId = await getHouseTenantId();
  const existing = await db
    .select({ id: csrBoxesTable.id })
    .from(csrBoxesTable)
    .where(eq(csrBoxesTable.tenantId, houseTenantId))
    .limit(1);
  if (existing.length === 0) {
    await db.insert(csrBoxesTable).values(
      DEFAULT_CSR_BOXES.map(b => ({
        tenantId: houseTenantId,
        slug: b.slug,
        label: b.label,
        displayOrder: b.displayOrder,
        isActive: true,
      }))
    );
  }
  shiftSchemaEnsured = true;
}

// ─── Helper: load active boxes for a tenant ───────────────────────────────────
async function getActiveCsrBoxes(tenantId: number) {
  return db
    .select()
    .from(csrBoxesTable)
    .where(and(eq(csrBoxesTable.tenantId, tenantId), eq(csrBoxesTable.isActive, true)))
    .orderBy(asc(csrBoxesTable.displayOrder), asc(csrBoxesTable.label));
}

router.use(async (_req, res, next) => {
  try {
    await ensureShiftSchema();
    next();
  } catch {
    res.status(500).json({ error: "Could not prepare shift schema" });
  }
});

async function ensureClockInInventoryTemplate(): Promise<typeof inventoryTemplatesTable.$inferSelect[]> {
  const houseTenantId = await getHouseTenantId();
  const rows = await db
    .select()
    .from(inventoryTemplatesTable)
    .where(eq(inventoryTemplatesTable.isActive, true))
    .orderBy(asc(inventoryTemplatesTable.displayOrder));

  const catalogRows = await db
    .select()
    .from(catalogItemsTable)
    .where(
      and(
        eq(catalogItemsTable.isAvailable, true),
        sql`COALESCE(${catalogItemsTable.isWooManaged}, false) = false`,
        sql`COALESCE(${catalogItemsTable.isLocalAlavont}, true) = true`,
      )
    )
    .orderBy(asc(catalogItemsTable.alavontCategory), asc(catalogItemsTable.name));

  if (catalogRows.length === 0) return rows;

  const existingTemplateRows = await db
    .select()
    .from(inventoryTemplatesTable)
    .where(eq(inventoryTemplatesTable.tenantId, houseTenantId));
  const existingCatalogIds = new Set(
    existingTemplateRows
      .map(r => r.catalogItemId)
      .filter((id): id is number => typeof id === "number")
  );

  const currentMaxOrder = existingTemplateRows.reduce((max, r) => Math.max(max, r.displayOrder ?? 0), 0);
  const toInsert = catalogRows
    .filter(item => !existingCatalogIds.has(item.id))
    .map((item, idx) => {
      const stockValue = item.inventoryAmount ?? item.stockQuantity ?? "0";
      const itemName = item.alavontName ?? item.displayName ?? item.name;
      return {
        tenantId: houseTenantId,
        sectionName: item.alavontCategory ?? item.category ?? "Alavont",
        itemName,
        rowType: "item",
        unitType: item.stockUnit ?? item.unitMeasurement ?? "#",
        startingQuantityDefault: String(stockValue ?? "0"),
        currentStock: String(stockValue ?? "0"),
        menuPrice: String(item.price ?? "0"),
        payoutPrice: String(item.costBasis ?? item.price ?? "0"),
        displayOrder: currentMaxOrder + ((idx + 1) * 10),
        isActive: true,
        catalogItemId: item.id,
        alavontId: item.alavontId ?? item.externalMenuId ?? null,
        deductionQuantityPerSale: "1",
        parLevel: String(item.parLevel ?? "0"),
      };
    });

  if (toInsert.length > 0) {
    await db.insert(inventoryTemplatesTable).values(toInsert);
  }

  return db
    .select()
    .from(inventoryTemplatesTable)
    .where(eq(inventoryTemplatesTable.isActive, true))
    .orderBy(asc(inventoryTemplatesTable.displayOrder));
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
  requireRole(...SHIFT_OPERATOR_ROLES),
  async (req, res): Promise<void> => {
    const rows = await ensureClockInInventoryTemplate();
    const houseTenantId = await getHouseTenantId();
    const dbBoxes = await getActiveCsrBoxes(houseTenantId);
    const boxes = dbBoxes.length > 0
      ? dbBoxes.map(b => ({ id: b.slug, label: b.label, description: b.description, location: b.location }))
      : DEFAULT_CSR_BOXES.map(b => ({ id: b.slug, label: b.label }));

    res.json({
      boxes,
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
  requireRole(...SHIFT_OPERATOR_ROLES),
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
      // Idempotent re-clock-in: return the existing active shift instead of
      // erroring so the UI doesn't double-create on retry / refresh races.
      res.status(200).json({ shift: existing[0], alreadyClockedIn: true });
      return;
    }

    const ip = getClientIp(req);
    const houseTenantId = await getHouseTenantId();

    const { inventorySnapshot, inventory: legacyInventory = [], cashBankStart, boxAssignmentId, setup } = req.body as {
      inventorySnapshot?: { templateItemId: number; quantityStart: number }[];
      inventory?: { catalogItemId?: number; itemName: string; unitPrice?: number; quantityStart: number }[];
      cashBankStart?: number;
      boxAssignmentId?: string;
      setup?: { wifiReady?: boolean; printerReady?: boolean; locationReady?: boolean };
    };

    const selectedBox = DEFAULT_CSR_BOXES.some(box => box.slug === boxAssignmentId)
      ? boxAssignmentId
      : DEFAULT_CSR_BOXES[0].slug;

    const [shift] = await db
      .insert(labTechShiftsTable)
      .values({
        tenantId: houseTenantId,
        techId: tech.id,
        status: "active",
        ipAddress: ip,
        cashBankStart: cashBankStart != null ? String(cashBankStart) : "0",
        boxAssignmentId: selectedBox,
        setupJson: {
          boxAssignmentId: selectedBox,
          wifiReady: setup?.wifiReady ?? false,
          printerReady: setup?.printerReady ?? false,
          locationReady: setup?.locationReady ?? true,
        },
      })
      .returning();

    let inventoryItemsInserted = 0;

    if (inventorySnapshot && inventorySnapshot.length > 0) {
      const templateRows = await ensureClockInInventoryTemplate();

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
  requireRole(...SHIFT_OPERATOR_ROLES),
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

    await writeAuditLog({
      actorId: tech.id,
      actorEmail: tech.email,
      actorRole: tech.role,
      action: "shift.clock_out",
      tenantId: activeShift.tenantId ?? null,
      resourceType: "lab_tech_shift",
      resourceId: String(activeShift.id),
      metadata: {
        clockedInAt: activeShift.clockedInAt,
        clockedOutAt: new Date().toISOString(),
        orderCount: stats.orderCount,
        totalRevenue: stats.totalRevenue,
        cashBankStart,
        cashBankEndReported: cashBankEndVal,
        cashDiscrepancy,
      },
      ipAddress: getClientIp(req),
    });

    res.json({ summary, shift: updatedShift });
  }
);

// ─── GET /api/shifts/current  (alias: /shifts/active) ────────────────────────
// Both paths return the caller's active shift (or { shift: null }). The
// /active alias matches the OpenAPI/spec wording in stab-02; /current is
// kept for backward-compat with the existing UI.
router.get(
  ["/shifts/current", "/shifts/active"],
  requireRole(...SHIFT_OPERATOR_ROLES),
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
  requireRole("global_admin", "admin"),
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
  requireRole(...SHIFT_OPERATOR_ROLES),
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
  requireRole("global_admin", "admin"),
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
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

    const {
      itemName, unitType, startingQuantityDefault, displayOrder, isActive,
      catalogItemId, deductionQuantityPerSale, sectionName, rowType, currentStock, parLevel,
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
      parLevel?: number | null;
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
    if (parLevel !== undefined) update.parLevel = parLevel != null ? String(parLevel) : "0";

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
  requireRole("global_admin", "admin"),
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
  requireRole("global_admin", "admin"),
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
  requireRole("global_admin", "admin"),
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

// ─── CSR Boxes Admin CRUD ──────────────────────────────────────────────────────

// GET /api/admin/csr-boxes — list all boxes (admin sees all; CSR uses /shifts/inventory-template)
router.get(
  "/admin/csr-boxes",
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    const houseTenantId = await getHouseTenantId();
    const rows = await db
      .select()
      .from(csrBoxesTable)
      .where(eq(csrBoxesTable.tenantId, houseTenantId))
      .orderBy(asc(csrBoxesTable.displayOrder), asc(csrBoxesTable.label));
    res.json({ boxes: rows });
  }
);

// POST /api/admin/csr-boxes — create a new box
router.post(
  "/admin/csr-boxes",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const { label, description, location, isActive = true, displayOrder = 0 } = req.body as {
      label?: string;
      description?: string;
      location?: string;
      isActive?: boolean;
      displayOrder?: number;
    };
    if (!label || String(label).trim() === "") {
      res.status(400).json({ error: "label is required" });
      return;
    }
    const houseTenantId = await getHouseTenantId();
    const slug = String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const [created] = await db
      .insert(csrBoxesTable)
      .values({ tenantId: houseTenantId, slug, label: String(label).trim(), description: description ?? null, location: location ?? null, isActive, displayOrder })
      .returning();
    await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: "CSR_BOX_CREATED", resourceType: "csr_box", resourceId: String(created.id), metadata: { label, slug } });
    res.status(201).json({ box: created });
  }
);

// PATCH /api/admin/csr-boxes/:id — update label/description/location/isActive/displayOrder
router.patch(
  "/admin/csr-boxes/:id",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

    const { label, description, location, isActive, displayOrder } = req.body as {
      label?: string;
      description?: string;
      location?: string;
      isActive?: boolean;
      displayOrder?: number;
    };

    const houseTenantId = await getHouseTenantId();
    const [existing] = await db.select().from(csrBoxesTable).where(and(eq(csrBoxesTable.id, id), eq(csrBoxesTable.tenantId, houseTenantId))).limit(1);
    if (!existing) { res.status(404).json({ error: "Box not found" }); return; }

    const update: Partial<typeof csrBoxesTable.$inferInsert> = {};
    if (label !== undefined) { update.label = String(label).trim(); update.slug = String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
    if (description !== undefined) update.description = description;
    if (location !== undefined) update.location = location;
    if (isActive !== undefined) update.isActive = isActive;
    if (displayOrder !== undefined) update.displayOrder = displayOrder;

    if (Object.keys(update).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }

    const [updated] = await db.update(csrBoxesTable).set(update).where(eq(csrBoxesTable.id, id)).returning();
    await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: "CSR_BOX_UPDATED", resourceType: "csr_box", resourceId: String(id), metadata: update as Record<string, unknown> });
    res.json({ box: updated });
  }
);

// DELETE /api/admin/csr-boxes/:id — deactivate (soft delete)
router.delete(
  "/admin/csr-boxes/:id",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

    const houseTenantId = await getHouseTenantId();
    const [existing] = await db.select().from(csrBoxesTable).where(and(eq(csrBoxesTable.id, id), eq(csrBoxesTable.tenantId, houseTenantId))).limit(1);
    if (!existing) { res.status(404).json({ error: "Box not found" }); return; }

    const [updated] = await db.update(csrBoxesTable).set({ isActive: false }).where(eq(csrBoxesTable.id, id)).returning();
    await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: "CSR_BOX_DEACTIVATED", resourceType: "csr_box", resourceId: String(id) });
    res.json({ box: updated });
  }
);

// ─── POST /api/shifts/:id/supervisor-checkout ─────────────────────────────────
// Supervisor confirms ending inventory, sets tip %, calculates final amounts.
router.post(
  "/shifts/:id/supervisor-checkout",
  requireRole("global_admin", "admin"),
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

// ─── GET /api/shifts/:id/restock-slip ────────────────────────────────────────
// Computes which items need restocking based on actual ending counts vs par level.
// Available immediately after clock-out (quantityEndActual recorded).
router.get(
  "/shifts/:id/restock-slip",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const shiftId = parseInt(String(req.params.id), 10);
    if (isNaN(shiftId)) { res.status(400).json({ error: "Invalid shift ID" }); return; }

    const [shift] = await db
      .select()
      .from(labTechShiftsTable)
      .where(eq(labTechShiftsTable.id, shiftId))
      .limit(1);
    if (!shift) { res.status(404).json({ error: "Shift not found" }); return; }

    const shiftItems = await db
      .select()
      .from(shiftInventoryItemsTable)
      .where(eq(shiftInventoryItemsTable.shiftId, shiftId))
      .orderBy(asc(shiftInventoryItemsTable.displayOrder));

    // Pull par levels from inventory templates
    const templateIds = shiftItems
      .filter(i => i.templateItemId != null)
      .map(i => i.templateItemId as number);

    const templates = templateIds.length
      ? await db
          .select({ id: inventoryTemplatesTable.id, parLevel: inventoryTemplatesTable.parLevel })
          .from(inventoryTemplatesTable)
          .where(
            templateIds.length === 1
              ? eq(inventoryTemplatesTable.id, templateIds[0])
              : sql`${inventoryTemplatesTable.id} = ANY(${sql.raw(`ARRAY[${templateIds.join(",")}]::int[]`)})`
          )
      : [];

    const parMap = new Map(templates.map(t => [t.id, parseFloat(String(t.parLevel ?? 0))]));

    const restockItems: {
      templateItemId: number | null;
      sectionName: string | null;
      itemName: string;
      unitType: string;
      parLevel: number;
      actualEndingQty: number;
      restockQty: number;
    }[] = [];

    for (const item of shiftItems) {
      if (item.rowType !== "item") continue;

      const parLevel = item.templateItemId ? (parMap.get(item.templateItemId) ?? 0) : 0;
      if (parLevel <= 0) continue;

      const actualEnding = item.quantityEndActual != null
        ? parseFloat(String(item.quantityEndActual))
        : null;

      if (actualEnding === null) continue;

      const restockQty = Math.max(0, parLevel - actualEnding);
      if (restockQty === 0) continue;

      restockItems.push({
        templateItemId: item.templateItemId,
        sectionName: item.sectionName,
        itemName: item.itemName,
        unitType: item.unitType ?? "#",
        parLevel,
        actualEndingQty: actualEnding,
        restockQty: Math.round(restockQty * 1000) / 1000,
      });
    }

    res.json({
      shiftId,
      generatedAt: new Date().toISOString(),
      totalItemsNeedingRestock: restockItems.length,
      items: restockItems,
    });
  }
);

// ─── POST /api/shifts/:id/restock-slip/print ─────────────────────────────────
// Generates and prints a restock slip for the shift via CUPS.
router.post(
  "/shifts/:id/restock-slip/print",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const shiftId = parseInt(String(req.params.id), 10);
    if (isNaN(shiftId)) { res.status(400).json({ error: "Invalid shift ID" }); return; }

    const [shift] = await db
      .select()
      .from(labTechShiftsTable)
      .where(eq(labTechShiftsTable.id, shiftId))
      .limit(1);
    if (!shift) { res.status(404).json({ error: "Shift not found" }); return; }

    const shiftItems = await db
      .select()
      .from(shiftInventoryItemsTable)
      .where(eq(shiftInventoryItemsTable.shiftId, shiftId))
      .orderBy(asc(shiftInventoryItemsTable.displayOrder));

    const templateIds = shiftItems
      .filter(i => i.templateItemId != null)
      .map(i => i.templateItemId as number);

    const templates = templateIds.length
      ? await db
          .select({ id: inventoryTemplatesTable.id, parLevel: inventoryTemplatesTable.parLevel })
          .from(inventoryTemplatesTable)
          .where(
            templateIds.length === 1
              ? eq(inventoryTemplatesTable.id, templateIds[0])
              : sql`${inventoryTemplatesTable.id} = ANY(${sql.raw(`ARRAY[${templateIds.join(",")}]::int[]`)})`
          )
      : [];

    const parMap = new Map(templates.map(t => [t.id, parseFloat(String(t.parLevel ?? 0))]));

    const lines: string[] = [];
    const W = 40;
    const divider = "=".repeat(W);
    const center = (s: string) => s.padStart(Math.floor((W + s.length) / 2)).padEnd(W);

    lines.push(divider);
    lines.push(center("RESTOCK SLIP"));
    lines.push(divider);
    lines.push(`Shift #: ${shiftId}`);
    lines.push(`Printed: ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`);
    lines.push(divider);

    let needCount = 0;
    let currentSection: string | null = null;

    for (const item of shiftItems) {
      if (item.rowType !== "item") continue;

      const parLevel = item.templateItemId ? (parMap.get(item.templateItemId) ?? 0) : 0;
      if (parLevel <= 0) continue;

      const actualEnding = item.quantityEndActual != null
        ? parseFloat(String(item.quantityEndActual))
        : null;
      if (actualEnding === null) continue;

      const restockQty = Math.max(0, parLevel - actualEnding);
      if (restockQty === 0) continue;

      if (item.sectionName && item.sectionName !== currentSection) {
        currentSection = item.sectionName;
        lines.push("");
        lines.push(`[ ${currentSection.toUpperCase()} ]`);
      }

      const name = item.itemName.length > 26 ? item.itemName.slice(0, 23) + "..." : item.itemName;
      const qty = `+${Math.round(restockQty * 1000) / 1000}${item.unitType ?? ""}`;
      lines.push(`  ${name.padEnd(W - qty.length - 2)}${qty}`);
      lines.push(`    par:${parLevel} | end:${actualEnding}`);
      needCount++;
    }

    lines.push("");
    lines.push(divider);
    lines.push(center(`TOTAL: ${needCount} items need restock`));
    lines.push(divider);
    lines.push("");

    const body = lines.join("\n");

    if (needCount === 0) {
      res.json({ ok: true, printed: false, message: "No items need restocking", shiftId });
      return;
    }

    try {
      const { printReceiptEscPos } = await import("../lib/escposPrinter");
      const { jobRef } = await printReceiptEscPos(body);
      res.json({ ok: true, printed: true, jobRef, itemCount: needCount, shiftId });
    } catch (err) {
      const msg = (err as Error).message;
      req.log.warn({ shiftId, err: msg }, "Restock slip print failed");
      res.status(500).json({ ok: false, printed: false, error: msg, shiftId });
    }
  }
);

// ─── GET /api/shifts/pending-supervisor ───────────────────────────────────────
// Returns all shifts awaiting supervisor checkout.
router.get(
  "/shifts/pending-supervisor",
  requireRole("global_admin", "admin"),
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
