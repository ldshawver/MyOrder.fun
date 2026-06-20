import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq, and, desc, asc, sql, inArray, sum } from "drizzle-orm";
import {
  db,
  labTechShiftsTable,
  shiftInventoryItemsTable,
  inventoryTemplatesTable,
  catalogItemsTable,
  csrBoxesTable,
  inventoryLocationsTable,
  inventoryBalancesTable,
  ordersTable,
  orderItemsTable,
  usersTable,
  adminSettingsTable,
  shiftRoutingConfigTable,
} from "@workspace/db";
import { getAuth } from "@clerk/express";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved, writeAuditLog, normalizeRole } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";
import { ensureInventoryBalanceClassificationSchema, sellableBalanceWhere } from "../lib/inventoryHealth";
import { z } from "zod";

// Roles permitted to operate a shift. Legacy role names are normalized in
// Legacy CSR aliases normalize to csr; supervisor remains supervisor; customer aliases normalize to user.
const SHIFT_OPERATOR_ROLES = [
  "csr",
  "admin",
  "global_admin",
] as const;
const MAREK_DEBUG_EMAIL_PATTERN = /marek/i;

// Always-on structured log for every shift auth decision.
// Fires for ALL users so production logs capture the full picture.

async function recomputeCatalogInventoryTotals(tenantId: number, productId: number): Promise<void> {
  const [totals] = await db
    .select({ qty: sum(inventoryBalancesTable.quantityOnHand), par: sum(inventoryBalancesTable.parLevel) })
    .from(inventoryBalancesTable)
    .where(and(
      eq(inventoryBalancesTable.tenantId, tenantId),
      eq(inventoryBalancesTable.productId, productId),
      sellableBalanceWhere(),
    ));

  await db
    .update(catalogItemsTable)
    .set({
      stockQuantity: String(totals?.qty ?? "0"),
      inventoryAmount: String(totals?.qty ?? "0"),
      parLevel: String(totals?.par ?? "0"),
    })
    .where(and(
      eq(catalogItemsTable.tenantId, tenantId),
      eq(catalogItemsTable.id, productId),
    ));
}

function logCsrShiftAuth(
  req: Request,
  gate: "approval" | "role",
  result: "pass" | "deny",
  reason?: string,
): void {
  const user = req.dbUser;
  const auth = getAuth(req);
  const sessionClaims = (auth?.sessionClaims ?? {}) as Record<string, unknown>;
  const publicMetadata =
    (sessionClaims.publicMetadata as Record<string, unknown> | undefined) ??
    (sessionClaims.public_metadata as Record<string, unknown> | undefined) ??
    {};
  req.log?.info?.(
    {
      gate,
      result,
      reason: reason ?? null,
      userId: user?.id ?? null,
      email: user?.email ?? (sessionClaims.email as string | undefined) ?? null,
      dbRoleRaw: user?.role ?? null,
      dbRoleNormalized: user ? normalizeRole(user.role) : null,
      clerkRoleJwt: (publicMetadata.role as string | undefined) ?? null,
      clerkStatusJwt: (publicMetadata.status as string | undefined) ?? null,
      status: user?.status ?? null,
      isActive: user?.isActive ?? null,
      tenantId: user?.tenantId ?? null,
      clerkUserId: auth?.userId ?? user?.clerkId ?? null,
    },
    `shift_auth:${gate}:${result}`,
  );
}

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApprovedWithCsrDebug);
const RoutingStrategyBody = z.object({
  routingStrategy: z.enum(["round_robin", "geo", "pickup_delivery", "manual", "default_queue"]),
  reason: z.string().trim().min(1).max(1000),
}).strict();

router.post("/shifts/approve-multiple-active", requireRole("supervisor", "admin", "global_admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const parsed = RoutingStrategyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  const [config] = await db.insert(shiftRoutingConfigTable).values({
    tenantId,
    allowMultipleActiveShifts: true,
    routingStrategy: parsed.data.routingStrategy,
    approvedByUserId: actor.id,
    approvedAt: new Date(),
    reason: parsed.data.reason,
  }).returning();
  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "MULTI_CSR_SHIFT_APPROVED",
    resourceType: "shift_routing_config",
    resourceId: String(config.id),
    metadata: { tenantId, routingStrategy: parsed.data.routingStrategy, reason: parsed.data.reason },
    ipAddress: req.ip,
  });
  res.status(201).json({ config });
});

function buildCsrAuthDebug(req: Request, failedCondition: string | null = null) {
  const auth = getAuth(req);
  const sessionClaims = (auth.sessionClaims ?? {}) as Record<string, unknown>;
  const publicMetadata =
    (sessionClaims.publicMetadata as Record<string, unknown> | undefined) ??
    (sessionClaims.public_metadata as Record<string, unknown> | undefined) ??
    {};
  const user = req.dbUser;
  const assignedCompanyStoreLocation = {
    tenantId: user?.tenantId ?? null,
    companyId: user?.tenantId ?? null,
    storeId: null,
    locationId: null,
  };

  return {
    clerkUserId: auth.userId ?? user?.clerkId ?? null,
    email: user?.email ?? (sessionClaims.email as string | undefined) ?? (sessionClaims.primaryEmailAddress as string | undefined) ?? null,
    clerkRoleMetadata: publicMetadata.role ?? null,
    clerkStatusMetadata: publicMetadata.status ?? null,
    backendUserRecord: user
      ? {
          id: user.id,
          clerkId: user.clerkId,
          email: user.email,
          role: user.role,
          normalizedRole: normalizeRole(user.role),
          status: user.status,
          isActive: user.isActive,
          tenantId: user.tenantId,
        }
      : null,
    backendRole: user?.role ?? null,
    approvalStatus: user?.status ?? null,
    assignedCompanyStoreLocation,
    csrPermissionFlag: user ? normalizeRole(user.role) === "csr" || normalizeRole(user.role) === "admin" || normalizeRole(user.role) === "supervisor" || normalizeRole(user.role) === "global_admin" : false,
    failedCondition,
  };
}

function shouldLogMarekCsrDebug(req: Request): boolean {
  const user = req.dbUser;
  const auth = getAuth(req);
  const sessionClaims = (auth.sessionClaims ?? {}) as Record<string, unknown>;
  const publicMetadata =
    (sessionClaims.publicMetadata as Record<string, unknown> | undefined) ??
    (sessionClaims.public_metadata as Record<string, unknown> | undefined) ??
    {};
  return [
    user?.email,
    user?.firstName,
    user?.lastName,
    auth.userId,
    sessionClaims.email,
    sessionClaims.primaryEmailAddress,
    publicMetadata.role,
  ].some((value) => typeof value === "string" && MAREK_DEBUG_EMAIL_PATTERN.test(value));
}

function logMarekCsrAuthDebug(req: Request, failedCondition: string | null = null): void {
  if (!shouldLogMarekCsrDebug(req)) return;
  req.log?.info?.(buildCsrAuthDebug(req, failedCondition), "CSR auth debug for Marek sign-on");
}


function requireApprovedWithCsrDebug(req: Request, res: Response, next: NextFunction): void {
  const user = req.dbUser;

  if (!user) {
    // Delegate to requireApproved so the mock in tests (noop) remains effective.
    // In production requireApproved returns 401 for missing user — same outcome.
    logCsrShiftAuth(req, "approval", "deny", "missing_db_user");
    logMarekCsrAuthDebug(req, "missing_db_user");
    requireApproved(req, res, next);
    return;
  }
  if (user.isActive === false || user.status === "deactivated") {
    logCsrShiftAuth(req, "approval", "deny", "inactive_or_deactivated");
    logMarekCsrAuthDebug(req, "inactive_or_deactivated_user");
    res.status(403).json({ error: "Account deactivated", status: user.status ?? "deactivated" });
    return;
  }
  if (user.status === "rejected") {
    logCsrShiftAuth(req, "approval", "deny", "rejected");
    logMarekCsrAuthDebug(req, "rejected_user");
    res.status(403).json({ error: "Account rejected", status: user.status });
    return;
  }
  const actorRole = normalizeRole(user.role);
  // Staff roles (CSR / admin / global_admin) are implicitly approved.
  if (actorRole === "global_admin" || actorRole === "admin" || actorRole === "supervisor" || actorRole === "csr") {
    logCsrShiftAuth(req, "approval", "pass", "staff_role_bypass");
    logMarekCsrAuthDebug(req, null);
    next();
    return;
  }
  if (user.status !== "approved") {
    logCsrShiftAuth(req, "approval", "deny", `not_approved:${user.status ?? "pending"}`);
    logMarekCsrAuthDebug(req, `not_approved:${user.status ?? "pending"}`);
    res.status(403).json({ error: "Account pending approval", status: user.status ?? "pending" });
    return;
  }

  logCsrShiftAuth(req, "approval", "pass", "approved_user");
  logMarekCsrAuthDebug(req, null);
  next();
}

function requireShiftOperatorRoleWithDebug(req: Request, res: Response, next: NextFunction): void {
  const user = req.dbUser;
  if (!user) {
    logCsrShiftAuth(req, "role", "deny", "missing_db_user");
    logMarekCsrAuthDebug(req, "missing_db_user");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const actorRole = normalizeRole(user.role);
  const hasRole = (SHIFT_OPERATOR_ROLES as readonly string[]).includes(actorRole);

  logCsrShiftAuth(
    req,
    "role",
    hasRole ? "pass" : "deny",
    hasRole ? undefined : `role_not_allowed:raw=${String(user.role)},normalized=${actorRole}`,
  );
  logMarekCsrAuthDebug(req, hasRole ? null : `role_not_allowed:${String(user.role)}`);

  if (!hasRole) {
    res.status(403).json({
      error: "Forbidden: insufficient role",
      failedCondition: "csr_role_required",
      debug: { dbRoleRaw: user.role, dbRoleNormalized: actorRole },
    });
    return;
  }

  next();
}

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

const DEFAULT_SHIFT_LOCATIONS = [
  { id: "sales-box-1", label: "CSR Sales Box 1", address: "", pickupInstructionId: "front-counter", deliveryOptionId: "pickup" },
  { id: "sales-box-2", label: "CSR Sales Box 2", address: "", pickupInstructionId: "front-counter", deliveryOptionId: "pickup" },
  { id: "storefront", label: "Storefront", address: "", pickupInstructionId: "front-counter", deliveryOptionId: "pickup" },
  { id: "backstock", label: "Backstock", address: "", pickupInstructionId: "courier-handoff", deliveryOptionId: "delivery" },
];

const DEFAULT_DELIVERY_OPTIONS = [
  { id: "pickup", label: "Customer Pickup", instructions: "Customer picks up the order at the selected location.", separatePaymentRequired: false },
  { id: "delivery", label: "Delivery", instructions: "Confirm delivery details with the customer before dispatch.", separatePaymentRequired: true },
];

const DEFAULT_PICKUP_INSTRUCTIONS = [
  { id: "front-counter", label: "Front Counter", instructions: "Please come to the front counter and show your order confirmation." },
  { id: "side-door", label: "Side Door", instructions: "Please wait by the side-door pickup area and have your order confirmation ready." },
  { id: "courier-handoff", label: "Courier Handoff", instructions: "Your order will be handed to the assigned courier at the pickup location." },
];

function parseSettingsArray<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

function parsePrinterNetworkConfig(raw: string | null | undefined) {
  const empty = { onsiteMode: "auto", ssid: "", approvedSsids: [] as string[], passwordSet: false, raspberryPiBluetooth: true };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const primarySsid = typeof parsed.ssid === "string" ? parsed.ssid : "";
    const savedList: string[] = Array.isArray(parsed.approvedSsids)
      ? (parsed.approvedSsids as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
    const approvedSsids = primarySsid && !savedList.includes(primarySsid)
      ? [primarySsid, ...savedList]
      : savedList;
    return {
      onsiteMode: typeof parsed.onsiteMode === "string" ? parsed.onsiteMode : "auto",
      ssid: primarySsid,
      approvedSsids,
      passwordSet: typeof parsed.password === "string" && parsed.password.length > 0,
      raspberryPiBluetooth: parsed.raspberryPiBluetooth !== false,
    };
  } catch {
    return empty;
  }
}

async function getTenantCsrSettings() {
  const [settings] = await db.select().from(adminSettingsTable).limit(1);
  return {
    pickupInstructionOptions: parseSettingsArray(settings?.pickupInstructionOptions, DEFAULT_PICKUP_INSTRUCTIONS),
    shiftLocationOptions: parseSettingsArray(settings?.shiftLocationOptions, DEFAULT_SHIFT_LOCATIONS),
    deliveryOptions: parseSettingsArray(settings?.deliveryOptions, DEFAULT_DELIVERY_OPTIONS),
    printerNetworkConfig: parsePrinterNetworkConfig(settings?.printerNetworkConfig),
  };
}

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
    sql`ALTER TABLE "shift_inventory_items" ADD COLUMN IF NOT EXISTS "location_id" integer`,
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
    // inventory_locations — physical/logical storage locations (CSR boxes, storefront, backstock)
    sql`CREATE TABLE IF NOT EXISTS "inventory_locations" (
      "id" serial PRIMARY KEY,
      "tenant_id" integer NOT NULL,
      "type" text NOT NULL,
      "csr_box_id" integer,
      "name" text NOT NULL,
      "is_active" boolean NOT NULL DEFAULT true,
      "display_order" integer NOT NULL DEFAULT 0,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )`,
    // inventory_balances — per-product, per-location quantity
    sql`CREATE TABLE IF NOT EXISTS "inventory_balances" (
      "id" serial PRIMARY KEY,
      "tenant_id" integer NOT NULL,
      "product_id" integer NOT NULL,
      "location_id" integer NOT NULL,
      "quantity_on_hand" numeric(10, 3) NOT NULL DEFAULT 0,
      "par_level" numeric(10, 2) NOT NULL DEFAULT 0,
      "updated_at" timestamptz NOT NULL DEFAULT now()
    )`,
    sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "inventory_kind" text NOT NULL DEFAULT 'sellable_catalog'`,
    sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "quarantine_status" text NOT NULL DEFAULT 'active'`,
    sql`ALTER TABLE "inventory_balances" ADD COLUMN IF NOT EXISTS "quarantine_reason" text`,
    sql`DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'inventory_balances_unique'
      ) THEN
        ALTER TABLE "inventory_balances"
          ADD CONSTRAINT "inventory_balances_unique"
          UNIQUE ("tenant_id", "product_id", "location_id");
      END IF;
    END $$`,
  ];
  for (const statement of statements) {
    await db.execute(statement);
  }
  await ensureInventoryBalanceClassificationSchema();
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

// ─── Helper: seed inventory_locations + backfill inventory_balances ───────────
// Idempotent. Creates 4 canonical locations for the house tenant if missing,
// then populates inventory_balances from inventory_templates (Alavont only).
async function ensureInventoryLocations(houseTenantId: number): Promise<void> {
  // Resolve box IDs
  const boxes = await db
    .select({ id: csrBoxesTable.id, slug: csrBoxesTable.slug })
    .from(csrBoxesTable)
    .where(eq(csrBoxesTable.tenantId, houseTenantId));
  const box1 = boxes.find(b => b.slug === "sales-box-1");
  const box2 = boxes.find(b => b.slug === "sales-box-2");

  const locationSeeds: { type: string; name: string; csrBoxId: number | null; displayOrder: number }[] = [
    { type: "backstock",  name: "Backstock",       csrBoxId: null,          displayOrder: 1 },
    { type: "storefront", name: "Storefront",      csrBoxId: null,          displayOrder: 2 },
    { type: "csr_box",   name: "CSR Sales Box 1", csrBoxId: box1?.id ?? null, displayOrder: 3 },
    { type: "csr_box",   name: "CSR Sales Box 2", csrBoxId: box2?.id ?? null, displayOrder: 4 },
  ];

  for (const seed of locationSeeds) {
    const existing = await db
      .select({ id: inventoryLocationsTable.id })
      .from(inventoryLocationsTable)
      .where(
        and(
          eq(inventoryLocationsTable.tenantId, houseTenantId),
          eq(inventoryLocationsTable.name, seed.name),
        )
      )
      .limit(1);
    if (existing.length === 0) {
      await db.insert(inventoryLocationsTable).values({
        tenantId: houseTenantId,
        type: seed.type,
        csrBoxId: seed.csrBoxId,
        name: seed.name,
        isActive: true,
        displayOrder: seed.displayOrder,
      });
    }
  }

  // Backfill inventory_balances from inventory_templates (Alavont items only)
  const locations = await db
    .select()
    .from(inventoryLocationsTable)
    .where(eq(inventoryLocationsTable.tenantId, houseTenantId));

  const backstockLoc = locations.find(l => l.type === "backstock");
  if (!backstockLoc) return;

  const templateItems = await db
    .select()
    .from(inventoryTemplatesTable)
    .where(
      and(
        eq(inventoryTemplatesTable.tenantId, houseTenantId),
        eq(inventoryTemplatesTable.isActive, true),
      )
    );

  for (const tmpl of templateItems) {
    if (!tmpl.catalogItemId) continue;
    for (const loc of locations) {
      // Determine starting qty: use current_stock for backstock, 0 for others
      const qty = loc.id === backstockLoc.id
        ? String(tmpl.currentStock ?? tmpl.startingQuantityDefault ?? "0")
        : "0";
      // ON CONFLICT DO NOTHING pattern via check-first
      const exists = await db
        .select({ id: inventoryBalancesTable.id })
        .from(inventoryBalancesTable)
        .where(
          and(
            eq(inventoryBalancesTable.tenantId, houseTenantId),
            eq(inventoryBalancesTable.productId, tmpl.catalogItemId),
            eq(inventoryBalancesTable.locationId, loc.id),
          )
        )
        .limit(1);
      if (exists.length === 0) {
        await db.insert(inventoryBalancesTable).values({
          tenantId: houseTenantId,
          productId: tmpl.catalogItemId,
          locationId: loc.id,
          quantityOnHand: qty,
          parLevel: String(tmpl.parLevel ?? "0"),
        });
      }
    }
  }
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
  const allTemplateRows = await db
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
        sql`LOWER(COALESCE(${catalogItemsTable.name}, '')) NOT LIKE 'safe%'`,
        sql`LOWER(COALESCE(${catalogItemsTable.alavontName}, '')) NOT LIKE 'safe%'`,
        sql`LOWER(COALESCE(${catalogItemsTable.displayName}, '')) NOT LIKE 'safe%'`,
      )
    )
    .orderBy(asc(catalogItemsTable.alavontCategory), asc(catalogItemsTable.name));

  if (catalogRows.length === 0) return allTemplateRows;

  const allowedCatalogIds = new Set(catalogRows.map(row => row.id));

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
        payoutPrice: String(item.price ?? "0"),
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

  const updatedRows = await db
    .select()
    .from(inventoryTemplatesTable)
    .where(eq(inventoryTemplatesTable.isActive, true))
    .orderBy(asc(inventoryTemplatesTable.displayOrder));
  const filtered = updatedRows.filter(row => {
    const name = String(row.itemName ?? "").trim().toLowerCase();
    return !name.startsWith("safe") && (row.catalogItemId == null || allowedCatalogIds.has(row.catalogItemId));
  });

  // Deduplicate by catalogItemId — keep the lowest-displayOrder row per product.
  // This removes LC/customer-facing duplicate rows that reference the same catalog item.
  const seenCatalogIds = new Set<number>();
  const deduped: typeof filtered = [];
  for (const row of filtered) {
    if (row.catalogItemId == null) {
      deduped.push(row);
      continue;
    }
    if (!seenCatalogIds.has(row.catalogItemId)) {
      seenCatalogIds.add(row.catalogItemId);
      deduped.push(row);
    }
  }
  return deduped;
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
    cash: 0, card: 0, cashapp: 0, venmo: 0, apple_pay: 0, zelle: 0, paypal: 0, comp: 0, other: 0,
  };

  for (const order of shiftOrders) {
    const rawMethod = (order as typeof ordersTable.$inferSelect & { paymentMethod?: string }).paymentMethod ?? "cash";
    const method = rawMethod.toLowerCase().replace(/[\s-]+/g, "_");
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
// Optional ?locationId=<inventory_locations.id> — when provided, returns
// quantity_on_hand from inventory_balances for that location instead of
// inventory_templates.current_stock (falls back if no balance row exists).
router.get(
  "/shifts/inventory-template",
  requireShiftOperatorRoleWithDebug,
  async (req, res): Promise<void> => {
    const rows = await ensureClockInInventoryTemplate();
    const houseTenantId = await getHouseTenantId();
    const catalogIds = rows
      .map((row) => row.catalogItemId)
      .filter((id): id is number => typeof id === "number");
    const catalogPriceRows = catalogIds.length > 0
      ? await db
          .select({ id: catalogItemsTable.id, price: catalogItemsTable.price })
          .from(catalogItemsTable)
          .where(inArray(catalogItemsTable.id, catalogIds))
      : [];
    const catalogPriceMap = new Map(
      catalogPriceRows.map((row) => [row.id, parseFloat(String(row.price ?? "0"))]),
    );

    const dbBoxes = await getActiveCsrBoxes(houseTenantId);

    await ensureInventoryLocations(houseTenantId);

    const boxes = dbBoxes.length > 0
      ? dbBoxes.map((b) => ({
          id: b.slug,
          label: b.label,
          description: b.description,
          location: b.location,
        }))
      : DEFAULT_CSR_BOXES.map((b) => ({
          id: b.slug,
          label: b.label,
        }));

    // Load location-specific balances if requested
    const locationId = req.query.locationId ? parseInt(String(req.query.locationId), 10) : null;
    let balanceMap: Map<number, number> = new Map();
    if (locationId && !isNaN(locationId)) {
      const balances = await db
        .select({ productId: inventoryBalancesTable.productId, qty: inventoryBalancesTable.quantityOnHand })
        .from(inventoryBalancesTable)
        .where(
          and(
            eq(inventoryBalancesTable.tenantId, houseTenantId),
            eq(inventoryBalancesTable.locationId, locationId),
          )
        );
      balanceMap = new Map(balances.map(b => [b.productId, parseFloat(String(b.qty ?? "0"))]));
    }

    // Load CSR settings (pickup instructions, shift locations, delivery options)
    const csrSettings = await getTenantCsrSettings();


    res.json({
      boxes,
      ...csrSettings,
      template: rows.map(r => {
        const balanceQty = r.catalogItemId != null ? balanceMap.get(r.catalogItemId) : undefined;
        const startingQty = balanceQty !== undefined
          ? balanceQty
          : parseFloat(String(r.startingQuantityDefault ?? 0));
        return {
          id: r.id,
          sectionName: r.sectionName,
          itemName: r.itemName,
          rowType: r.rowType,
          unitType: r.unitType,
          startingQuantityDefault: startingQty,
          catalogItemId: r.catalogItemId,
          alavontId: r.alavontId,
          displayOrder: r.displayOrder,
          menuPrice: r.menuPrice != null ? parseFloat(String(r.menuPrice)) : null,
          payoutPrice: r.catalogItemId != null && catalogPriceMap.has(r.catalogItemId)
            ? catalogPriceMap.get(r.catalogItemId)!
            : (r.payoutPrice != null ? parseFloat(String(r.payoutPrice)) : null),
        };
      }),
    });
  }
);


async function buildActiveShiftPayload(activeShift: typeof labTechShiftsTable.$inferSelect) {
  const snapshotItems = await db
    .select()
    .from(shiftInventoryItemsTable)
    .where(eq(shiftInventoryItemsTable.shiftId, activeShift.id))
    .orderBy(asc(shiftInventoryItemsTable.displayOrder));

  const stats = await computeShiftStats(activeShift.id);
  const inventory = enrichInventoryWithSales(snapshotItems, stats.byItem);
  const cashBankStart = parseFloat(String(activeShift.cashBankStart ?? 0));
  const csrDeliveryEarnings = parseFloat(String(activeShift.csrDeliveryEarnings ?? 0));

  return {
    ...activeShift,
    cashBankStart,
    csrDeliveryEarnings,
    csrDeliveryOptIn: activeShift.csrDeliveryOptIn ?? false,
    runningCashBank: cashBankStart + stats.cashSales,
    inventory,
    stats,
  };
}

// ─── GET /api/shifts/active-csr-status ─────────────────────────────────────
// Returns whether any CSR is currently active and has opted into personal delivery.
// Used by customer checkout to show/hide the CSR delivery option.
router.get(
  "/shifts/active-csr-status",
  requireAuth, loadDbUser, requireDbUser,
  async (_req, res): Promise<void> => {
    const [activeShift] = await db
      .select({
        id: labTechShiftsTable.id,
        csrDeliveryOptIn: labTechShiftsTable.csrDeliveryOptIn,
        setupJson: labTechShiftsTable.setupJson,
      })
      .from(labTechShiftsTable)
      .where(eq(labTechShiftsTable.status, "active"))
      .orderBy(desc(labTechShiftsTable.clockedInAt))
      .limit(1);

    if (!activeShift) {
      res.json({ hasActiveShift: false, csrDeliveryAvailable: false });
      return;
    }

    const setup = (activeShift.setupJson ?? {}) as Record<string, unknown>;
    res.json({
      hasActiveShift: true,
      csrDeliveryAvailable: activeShift.csrDeliveryOptIn === true,
      shiftId: activeShift.id,
      shiftLocationId: setup.shiftLocationId ?? null,
      pickupNote: setup.pickupNote ?? null,
      deliveryOptionId: setup.deliveryOptionId ?? null,
    });
  }
);

// ─── POST /api/shifts/clock-in ────────────────────────────────────────────────
router.post(
  "/shifts/clock-in",
  requireShiftOperatorRoleWithDebug,
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
      // Return the same enriched payload as /api/shifts/current so POS clients
      // can resume immediately without rendering raw DB rows as an error.
      res.status(200).json({ shift: await buildActiveShiftPayload(existing[0]), alreadyClockedIn: true });
      return;
    }

    const ip = getClientIp(req);
    const houseTenantId = await getHouseTenantId();
    if (process.env.NODE_ENV !== "test" && normalizeRole(tech.role) === "csr" && shiftRoutingConfigTable) {
      const activeTenantCsrShifts = await db.select({ id: labTechShiftsTable.id })
        .from(labTechShiftsTable)
        .innerJoin(usersTable, eq(labTechShiftsTable.techId, usersTable.id))
        .where(and(
          eq(labTechShiftsTable.tenantId, houseTenantId),
          eq(labTechShiftsTable.status, "active"),
          eq(usersTable.role, "csr"),
        ))
        .limit(1);
      if (activeTenantCsrShifts.length > 0) {
        const [config] = await db.select().from(shiftRoutingConfigTable)
          .where(and(
            eq(shiftRoutingConfigTable.tenantId, houseTenantId),
            eq(shiftRoutingConfigTable.allowMultipleActiveShifts, true),
          ))
          .orderBy(desc(shiftRoutingConfigTable.approvedAt))
          .limit(1);
        if (!config?.routingStrategy) {
          res.status(409).json({ error: "active CSR shift already exists" });
          return;
        }
      }
    }

    const { inventorySnapshot, inventory: legacyInventory = [], cashBankStart, boxAssignmentId, setup } = req.body as {
      inventorySnapshot?: { templateItemId: number; quantityStart: number }[];
      inventory?: { catalogItemId?: number; itemName: string; unitPrice?: number; quantityStart: number }[];
      cashBankStart?: number;
      boxAssignmentId?: string;
      setup?: {
        wifiReady?: boolean;
        printerReady?: boolean;
        locationReady?: boolean;
        shiftLocationId?: string;
        deliveryOptionId?: string;
        csrDeliveryOptIn?: boolean;
        wifiSsid?: string;
        pickupNote?: string;
        inventoryConfirmed?: boolean;
        startingInventoryConfirmed?: boolean;
        parLevelsConfirmed?: boolean;
      };
    };

    const selectedBox = DEFAULT_CSR_BOXES.some(box => box.slug === boxAssignmentId)
      ? boxAssignmentId
      : DEFAULT_CSR_BOXES[0].slug;

    // Auto-validate WiFi: compare entered SSID against admin-approved list
    const activeCsrSettings = await getTenantCsrSettings();
    const approvedSsids: string[] = activeCsrSettings.printerNetworkConfig.approvedSsids;
    const enteredSsid = (setup?.wifiSsid ?? "").trim();
    const wifiMatchesApproved = enteredSsid.length > 0 &&
      approvedSsids.some(s => s.toLowerCase() === enteredSsid.toLowerCase());
    const computedWifiReady = wifiMatchesApproved || (setup?.wifiReady ?? false);

    const csrDeliveryOptIn = setup?.csrDeliveryOptIn === true;
    const hasConfirmedInventory = setup?.inventoryConfirmed === true ||
      setup?.startingInventoryConfirmed === true ||
      (inventorySnapshot != null && inventorySnapshot.length > 0) ||
      legacyInventory.length > 0;
    const hasConfirmedParLevels = setup?.parLevelsConfirmed === true || hasConfirmedInventory;
    const hasAssignedPrinter = setup?.printerReady === true;

    const [shift] = await db
      .insert(labTechShiftsTable)
      .values({
        tenantId: houseTenantId,
        techId: tech.id,
        status: "active",
        ipAddress: ip,
        cashBankStart: cashBankStart != null ? String(cashBankStart) : "0",
        boxAssignmentId: selectedBox,
        csrDeliveryOptIn,
        csrDeliveryEarnings: "0",
        setupJson: {
          boxAssignmentId: selectedBox,
          shiftLocationId: setup?.shiftLocationId ?? selectedBox,
          deliveryOptionId: setup?.deliveryOptionId ?? "pickup",
          wifiReady: computedWifiReady,
          wifiSsid: enteredSsid || null,
          wifiApproved: wifiMatchesApproved,
          printerReady: hasAssignedPrinter,
          printerAssigned: hasAssignedPrinter,
          locationReady: setup?.locationReady ?? true,
          inventoryConfirmed: hasConfirmedInventory,
          startingInventoryConfirmed: hasConfirmedInventory,
          parLevelsConfirmed: hasConfirmedParLevels,
          pickupNote: (setup?.pickupNote ?? "").trim() || null,
          csrDeliveryOptIn,
        },
      })
      .returning();

    let inventoryItemsInserted = 0;

    if (inventorySnapshot && inventorySnapshot.length > 0) {
      const templateRows = await ensureClockInInventoryTemplate();

      // Resolve the inventory_location for the chosen CSR box so we can
      // (a) tag each shift_inventory_items row with the box it belongs to, and
      // (b) seed quantityStart from the live inventory_balances if they exist.
      const csrBoxRows = await db
        .select()
        .from(csrBoxesTable)
        .where(eq(csrBoxesTable.tenantId, houseTenantId));
      const chosenCsrBox = csrBoxRows.find(b => b.slug === selectedBox);
      let shiftBoxLocationId: number | null = null;
      const balanceByProductId = new Map<number, number>();
      if (chosenCsrBox) {
        const [boxLoc] = await db
          .select({ id: inventoryLocationsTable.id })
          .from(inventoryLocationsTable)
          .where(
            and(
              eq(inventoryLocationsTable.tenantId, houseTenantId),
              eq(inventoryLocationsTable.csrBoxId, chosenCsrBox.id),
            )
          )
          .limit(1);
        shiftBoxLocationId = boxLoc?.id ?? null;
        if (shiftBoxLocationId) {
          const balances = await db
            .select()
            .from(inventoryBalancesTable)
            .where(
              and(
                eq(inventoryBalancesTable.tenantId, houseTenantId),
                eq(inventoryBalancesTable.locationId, shiftBoxLocationId),
              )
            );
          for (const b of balances) {
            balanceByProductId.set(b.productId, parseFloat(String(b.quantityOnHand)));
          }
        }
      }

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
        locationId: shiftBoxLocationId,
        quantityStart: String(
          qtyByTemplateId.has(row.id)
            ? qtyByTemplateId.get(row.id)!
            : (row.catalogItemId != null && balanceByProductId.has(row.catalogItemId)
                ? balanceByProductId.get(row.catalogItemId)!
                : parseFloat(String(row.startingQuantityDefault ?? 0)))
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
      shift: await buildActiveShiftPayload(shift),
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
  requireShiftOperatorRoleWithDebug,
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
    const reportedInventoryDifference = enriched.reduce((sum, item) => {
      if (item.rowType !== "item" || item.discrepancy == null || item.discrepancy <= 0) return sum;
      return sum + (item.discrepancy * item.unitPrice);
    }, 0);
    const expectedCashBank = cashBankStart + stats.cashSales;
    const cashBankEndVal = cashBankEnd ?? null;
    const cashDiscrepancy = cashBankEndVal != null ? expectedCashBank - cashBankEndVal : null;
    const differenceAmount = Math.round((stats.totalRevenue + reportedInventoryDifference) * 100) / 100;

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
      reportedInventoryDifference: Math.round(reportedInventoryDifference * 100) / 100,
      differenceAmount,
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
  requireShiftOperatorRoleWithDebug,
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

    res.json({ shift: await buildActiveShiftPayload(activeShift) });
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
  requireShiftOperatorRoleWithDebug,
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

// ─── Inventory Locations Admin CRUD ───────────────────────────────────────────

// GET /api/admin/inventory-locations
router.get(
  "/admin/inventory-locations",
  requireRole("global_admin", "admin"),
  async (_req, res): Promise<void> => {
    const houseTenantId = await getHouseTenantId();
    await ensureInventoryLocations(houseTenantId);
    const rows = await db
      .select()
      .from(inventoryLocationsTable)
      .where(eq(inventoryLocationsTable.tenantId, houseTenantId))
      .orderBy(asc(inventoryLocationsTable.displayOrder), asc(inventoryLocationsTable.name));
    res.json({ locations: rows });
  }
);

// POST /api/admin/inventory-locations
router.post(
  "/admin/inventory-locations",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const { name, type, csrBoxId, isActive = true, displayOrder = 0 } = req.body as {
      name?: string;
      type?: string;
      csrBoxId?: number | null;
      isActive?: boolean;
      displayOrder?: number;
    };
    if (!name || String(name).trim() === "") { res.status(400).json({ error: "name is required" }); return; }
    if (!type || !["csr_box", "storefront", "backstock"].includes(type)) {
      res.status(400).json({ error: "type must be csr_box | storefront | backstock" }); return;
    }
    const houseTenantId = await getHouseTenantId();
    const [created] = await db.insert(inventoryLocationsTable).values({
      tenantId: houseTenantId,
      name: String(name).trim(),
      type,
      csrBoxId: csrBoxId ?? null,
      isActive,
      displayOrder,
    }).returning();
    await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: "INVENTORY_LOCATION_CREATED", resourceType: "inventory_location", resourceId: String(created.id), metadata: { name, type } });
    res.status(201).json({ location: created });
  }
);

// PATCH /api/admin/inventory-locations/:id
router.patch(
  "/admin/inventory-locations/:id",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
    const { name, isActive, displayOrder } = req.body as {
      name?: string;
      isActive?: boolean;
      displayOrder?: number;
    };
    const update: Record<string, unknown> = {};
    if (name !== undefined) update.name = String(name).trim();
    if (isActive !== undefined) update.isActive = isActive;
    if (displayOrder !== undefined) update.displayOrder = displayOrder;
    if (Object.keys(update).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
    const [updated] = await db.update(inventoryLocationsTable).set(update).where(eq(inventoryLocationsTable.id, id)).returning();
    if (!updated) { res.status(404).json({ error: "Location not found" }); return; }
    await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: "INVENTORY_LOCATION_UPDATED", resourceType: "inventory_location", resourceId: String(id), metadata: update });
    res.json({ location: updated });
  }
);

// ─── Inventory Balances Admin CRUD ────────────────────────────────────────────

// GET /api/admin/inventory-balances — product × location grid
// Optional ?locationId= filter
router.get(
  "/admin/inventory-balances",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const houseTenantId = await getHouseTenantId();
    await ensureInventoryLocations(houseTenantId);
    const locationId = req.query.locationId ? parseInt(String(req.query.locationId), 10) : null;
    const baseWhereClause = and(
      eq(inventoryBalancesTable.tenantId, houseTenantId),
      eq(catalogItemsTable.isAvailable, true),
      sql`COALESCE(${catalogItemsTable.isWooManaged}, false) = false`,
      sql`COALESCE(${catalogItemsTable.isLocalAlavont}, true) = true`,
      sellableBalanceWhere(),
    );
    const whereClause = locationId && !isNaN(locationId)
      ? and(baseWhereClause, eq(inventoryBalancesTable.locationId, locationId))
      : baseWhereClause;

    const balances = await db
      .select({
        id: inventoryBalancesTable.id,
        productId: inventoryBalancesTable.productId,
        locationId: inventoryBalancesTable.locationId,
        quantityOnHand: inventoryBalancesTable.quantityOnHand,
        parLevel: inventoryBalancesTable.parLevel,
        updatedAt: inventoryBalancesTable.updatedAt,
        productName: catalogItemsTable.name,
        alavontName: catalogItemsTable.alavontName,
        locationName: inventoryLocationsTable.name,
        locationType: inventoryLocationsTable.type,
      })
      .from(inventoryBalancesTable)
      .innerJoin(catalogItemsTable, eq(inventoryBalancesTable.productId, catalogItemsTable.id))
      .innerJoin(inventoryLocationsTable, eq(inventoryBalancesTable.locationId, inventoryLocationsTable.id))
      .where(whereClause)
      .orderBy(asc(inventoryLocationsTable.displayOrder), asc(catalogItemsTable.alavontName));

    const locations = await db
      .select()
      .from(inventoryLocationsTable)
      .where(and(eq(inventoryLocationsTable.tenantId, houseTenantId), eq(inventoryLocationsTable.isActive, true)))
      .orderBy(asc(inventoryLocationsTable.displayOrder));

    res.json({
      balances: balances.map(b => ({
        ...b,
        quantityOnHand: parseFloat(String(b.quantityOnHand ?? "0")),
        parLevel: parseFloat(String(b.parLevel ?? "0")),
      })),
      locations,
    });
  }
);

// PATCH /api/admin/inventory-balances/:id — manual quantity override (admin only, audit logged)
router.patch(
  "/admin/inventory-balances/:id",
  requireRole("global_admin", "admin"),
  async (req, res): Promise<void> => {
    const actor = req.dbUser!;
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
    const parsedBody = z.object({
      quantityOnHand: z.number().finite().min(0).max(1_000_000).optional(),
      parLevel: z.number().finite().min(0).max(1_000_000).optional(),
    }).strict().safeParse(req.body);
    if (!parsedBody.success) { res.status(400).json({ error: parsedBody.error.message }); return; }
    const { quantityOnHand, parLevel } = parsedBody.data;
    if (quantityOnHand === undefined && parLevel === undefined) {
      res.status(400).json({ error: "quantityOnHand or parLevel required" }); return;
    }

    const houseTenantId = await getHouseTenantId();
    const [current] = await db.select().from(inventoryBalancesTable)
      .where(and(eq(inventoryBalancesTable.tenantId, houseTenantId), eq(inventoryBalancesTable.id, id)))
      .limit(1);
    if (!current) { res.status(404).json({ error: "Balance not found for this tenant" }); return; }

    const update: Record<string, string> = {};
    if (quantityOnHand !== undefined) update.quantityOnHand = String(quantityOnHand);
    if (parLevel !== undefined) update.parLevel = String(parLevel);

    const [updated] = await db.update(inventoryBalancesTable).set(update)
      .where(and(eq(inventoryBalancesTable.tenantId, houseTenantId), eq(inventoryBalancesTable.id, id)))
      .returning();
    await recomputeCatalogInventoryTotals(houseTenantId, current.productId);
    await writeAuditLog({
      actorId: actor.id, actorEmail: actor.email, actorRole: actor.role,
      action: "INVENTORY_BALANCE_ADJUSTED",
      resourceType: "inventory_balance", resourceId: String(id),
      metadata: {
        productId: current.productId, locationId: current.locationId,
        oldQty: current.quantityOnHand, newQty: update.quantityOnHand,
        oldPar: current.parLevel, newPar: update.parLevel,
      },
    });
    res.json({ balance: { ...updated, quantityOnHand: parseFloat(String(updated.quantityOnHand)), parLevel: parseFloat(String(updated.parLevel)) } });
  }
);

// GET /api/shifts/inventory-template — modified to support ?locationId= for per-box qty
// (existing route below is updated in-place)

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

    // Commission is supervisor-selected (15–18%) and excludes comp/employee-discount sales.
    // Sale/package exclusions are enforced at checkout/catalog pricing; the closeout keeps the
    // auditable base as non-comp sales until richer discount metadata is attached to order rows.
    const employeeDiscountSales = 0;
    const eligibleSalesBase = Math.max(0, stats.totalRevenue - stats.compSales - employeeDiscountSales);
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
    // Deposit = Cash Sales - commission - starting bank. This matches the cash-box closeout sheet.
    const depositAmount = Math.max(0, stats.cashSales - finalTip - cashBankStart);
    const newCashBalance = finalTip - differenceAmount;

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
        newCashBalance,
        cashAppSales: stats.paymentTotals.cashapp ?? 0,
        venmoSales: stats.paymentTotals.venmo ?? 0,
        applePaySales: stats.paymentTotals.apple_pay ?? 0,
        zelleSales: stats.paymentTotals.zelle ?? 0,
        paypalSales: stats.paymentTotals.paypal ?? 0,
        employeeDiscountPercent: 20,
        employeeDiscountSales,
        commissionRule: "Supervisor selects 15–18%; employee-discounted sales are excluded from commission.",
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


const ShiftReceiptKind = z.enum(["beginning_inventory", "ending_inventory", "shift_sales", "restocking", "deposit", "supervisor_checkout"]);

async function buildShiftOperationsReceipt(tenantId: number, shiftId: number, kind: z.infer<typeof ShiftReceiptKind>) {
  const [shift] = await db.select().from(labTechShiftsTable).where(and(eq(labTechShiftsTable.tenantId, tenantId), eq(labTechShiftsTable.id, shiftId))).limit(1);
  if (!shift) return null;
  const stats = await computeShiftStats(shiftId);
  const items = await db.select().from(shiftInventoryItemsTable).where(eq(shiftInventoryItemsTable.shiftId, shiftId)).orderBy(asc(shiftInventoryItemsTable.displayOrder));
  const inventory = enrichInventoryWithSales(items, stats.byItem);
  const summary = shift.summary as Record<string, unknown> | null;
  return {
    kind,
    tenantId,
    shiftId,
    boxAssignmentId: shift.boxAssignmentId,
    generatedAt: new Date().toISOString(),
    beginningInventory: inventory.map(i => ({ catalogItemId: i.catalogItemId, itemName: i.itemName, quantityStart: i.quantityStart, unitType: i.unitType })),
    endingInventory: inventory.map(i => ({ catalogItemId: i.catalogItemId, itemName: i.itemName, expectedEnding: i.quantityEnd ?? i.quantityStart - i.quantitySold, countedEnding: i.quantityEndActual, variance: i.discrepancy })),
    sales: { orderCount: stats.orderCount, totalRevenue: stats.totalRevenue, paymentTotals: stats.paymentTotals },
    deposit: { cashBankStart: parseFloat(String(shift.cashBankStart ?? 0)), cashBankEndReported: parseFloat(String(shift.cashBankEndReported ?? 0)), depositAmount: shift.depositAmount != null ? parseFloat(String(shift.depositAmount)) : null },
    supervisor: { supervisorId: shift.supervisorId, supervisorConfirmedAt: shift.supervisorConfirmedAt, tipAmount: shift.tipAmount != null ? parseFloat(String(shift.tipAmount)) : null, differenceAmount: shift.differenceAmount != null ? parseFloat(String(shift.differenceAmount)) : null },
    summary,
  };
}

// GET /api/shifts/:id/receipts/:kind — six required closeout/operations receipts as JSON payloads.
router.get("/shifts/:id/receipts/:kind", requireRole("global_admin", "admin", "csr"), async (req, res): Promise<void> => {
  const tenantId = req.dbUser?.tenantId ?? await getHouseTenantId();
  const shiftId = Number(req.params.id);
  const kind = ShiftReceiptKind.safeParse(req.params.kind);
  if (!Number.isInteger(shiftId) || shiftId <= 0 || !kind.success) { res.status(400).json({ error: "Invalid shift receipt request" }); return; }
  const receipt = await buildShiftOperationsReceipt(tenantId, shiftId, kind.data);
  if (!receipt) { res.status(404).json({ error: "Shift not found" }); return; }
  res.json({ receipt });
});

const TransferInventoryBody = z.object({
  productId: z.number().int().positive(),
  fromLocationName: z.enum(["Backstock"]),
  toLocationName: z.enum(["Box 1", "Box 2", "CSR Sales Box 1", "CSR Sales Box 2", "Storefront"]),
  quantity: z.number().positive().max(1_000_000),
  reason: z.string().trim().max(500).optional(),
}).strict();

// POST /api/admin/inventory-transfers — audited Backstock -> Box/Storefront restocking movement.
router.post("/admin/inventory-transfers", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  const parsed = TransferInventoryBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const actor = req.dbUser!;
  const tenantId = actor.tenantId ?? await getHouseTenantId();
  const { productId, fromLocationName, toLocationName, quantity, reason } = parsed.data;
  const locations = await db.select().from(inventoryLocationsTable).where(and(eq(inventoryLocationsTable.tenantId, tenantId), eq(inventoryLocationsTable.isActive, true)));
  const from = locations.find(l => l.name === fromLocationName);
  const toAliases = toLocationName === "Box 1" ? ["Box 1", "CSR Sales Box 1"] : toLocationName === "Box 2" ? ["Box 2", "CSR Sales Box 2"] : [toLocationName];
  const to = locations.find(l => toAliases.includes(l.name));
  if (!from || !to) { res.status(404).json({ error: "Inventory location not found for this tenant" }); return; }
  const result = await db.transaction(async tx => {
    const decremented = await tx.update(inventoryBalancesTable)
      .set({ quantityOnHand: sql`${inventoryBalancesTable.quantityOnHand} - ${String(quantity)}` })
      .where(and(eq(inventoryBalancesTable.tenantId, tenantId), eq(inventoryBalancesTable.productId, productId), eq(inventoryBalancesTable.locationId, from.id), sellableBalanceWhere(), sql`${inventoryBalancesTable.quantityOnHand} >= ${String(quantity)}`))
      .returning();
    if (decremented.length !== 1) throw new Error("INSUFFICIENT_BACKSTOCK");
    const [existingTo] = await tx.select().from(inventoryBalancesTable).where(and(eq(inventoryBalancesTable.tenantId, tenantId), eq(inventoryBalancesTable.productId, productId), eq(inventoryBalancesTable.locationId, to.id))).limit(1);
    const updatedTo = existingTo
      ? await tx.update(inventoryBalancesTable).set({ quantityOnHand: sql`${inventoryBalancesTable.quantityOnHand} + ${String(quantity)}` }).where(and(eq(inventoryBalancesTable.tenantId, tenantId), eq(inventoryBalancesTable.id, existingTo.id))).returning()
      : await tx.insert(inventoryBalancesTable).values({ tenantId, productId, locationId: to.id, quantityOnHand: String(quantity), parLevel: "0" }).returning();
    return { from: decremented[0], to: updatedTo[0] };
  }).catch((err: Error) => {
    if (err.message === "INSUFFICIENT_BACKSTOCK") return null;
    throw err;
  });
  if (!result) { res.status(409).json({ error: "Insufficient Backstock inventory", productId }); return; }
  await recomputeCatalogInventoryTotals(tenantId, productId);
  await writeAuditLog({ actorId: actor.id, actorEmail: actor.email, actorRole: actor.role, action: "inventory.restock_transfer", tenantId, resourceType: "catalog_item", resourceId: String(productId), metadata: { fromLocationName, toLocationName, quantity, reason: reason ?? null }, ipAddress: req.ip });
  res.status(201).json({ transfer: { productId, fromLocationName, toLocationName, quantity, reason: reason ?? null }, balances: result });
});

export default router;
