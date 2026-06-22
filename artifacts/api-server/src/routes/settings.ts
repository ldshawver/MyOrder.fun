import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db, adminSettingsTable, customerDisclaimerAcceptancesTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved, writeAuditLog } from "../lib/auth";
import { requirePermission, isGlobalAdmin } from "../lib/roles";
import { getHouseTenantId } from "../lib/singleTenant";
import { encrypt, safeDecrypt } from "../lib/crypto";
import { z } from "zod";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

function requireTenantAssignedOrGlobal(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): void {
  const actor = req.dbUser!;
  if (isGlobalAdmin(actor) || actor.tenantId != null) return next();
  res.status(403).json({ error: "Tenant-scoped settings access requires a tenant assignment" });
}


const ROUTING_RULES = ["round_robin", "least_recent_order", "supervisor_manual_assignment"] as const;
type RoutingRule = typeof ROUTING_RULES[number];
type AdminSettingsWithCsr = typeof adminSettingsTable.$inferSelect & {
  shiftLocationOptions?: string | null;
  deliveryOptions?: string | null;
};

// Hard cap on the admin-editable AI prompt to avoid pathological prompts
// or accidental paste-the-whole-document mistakes blowing the model context.
export const AI_CONCIERGE_PROMPT_MAX_CHARS = 8000;
let adminSettingsSchemaEnsured = false;

async function ensureAdminSettingsSchema(): Promise<void> {
  if (adminSettingsSchemaEnsured) return;

  const statements = [
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "menu_import_enabled" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "show_out_of_stock" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "enabled_processors" text[] NOT NULL DEFAULT ARRAY['stripe']::text[]`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "checkout_conversion_preview" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "merchant_image_enabled" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "merchant_processor_config" text`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "auto_print_on_payment" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "receipt_template_style" text NOT NULL DEFAULT 'standard'`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "label_template_style" text NOT NULL DEFAULT 'standard'`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "purge_mode" text NOT NULL DEFAULT 'delayed'`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "purge_delay_hours" integer NOT NULL DEFAULT 72`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "keep_audit_token" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "keep_failed_payment_logs" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "petty_cash" numeric(10, 2) DEFAULT '0'`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "receipt_line_name_mode" text NOT NULL DEFAULT 'lucifer_only'`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "wc_store_url" text DEFAULT 'https://lucifercruz.com'`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "wc_consumer_key" text`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "wc_consumer_secret" text`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "wc_enabled" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "order_routing_rule" text NOT NULL DEFAULT 'round_robin'`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "default_eta_minutes" integer NOT NULL DEFAULT 30`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "ai_concierge_prompt" text`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "concierge_intro_steps" text`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "concierge_promoted_item_ids" text`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "catalog_banner_images" text`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "import_template_spec" text`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "pickup_instruction_options" text`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "shift_location_options" text`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "delivery_options" text`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "printer_network_config" text`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "privacy_mode_enabled" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "sensitive_screens_protection_enabled" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "watermark_sensitive_screens" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "privacy_blur_on_background" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "privacy_print_blocking_enabled" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "privacy_protected_roles" text[] NOT NULL DEFAULT ARRAY['user','csr','supervisor','admin','global_admin']::text[]`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "customer_disclaimer_text" text NOT NULL DEFAULT 'Before using MyOrder.fun, you confirm that you are authorized to access this customer account, that the information you provide is accurate, and that you agree to follow all applicable terms, privacy, ordering, pickup, and payment policies.'`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "customer_disclaimer_version" integer NOT NULL DEFAULT 1`,
    sql`CREATE TABLE IF NOT EXISTS "customer_disclaimer_acceptances" ("id" serial PRIMARY KEY, "tenant_id" integer NOT NULL REFERENCES "tenants"("id"), "user_id" integer NOT NULL REFERENCES "users"("id"), "disclaimer_version" integer NOT NULL, "accepted_at" timestamp with time zone NOT NULL DEFAULT now())`,
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "customer_disclaimer_acceptances_tenant_user_version_idx" ON "customer_disclaimer_acceptances" ("tenant_id", "user_id", "disclaimer_version")`,
    sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL`,
  ];

  for (const statement of statements) {
    await db.execute(statement);
  }
  adminSettingsSchemaEnsured = true;
}

function mapSettings(s: typeof adminSettingsTable.$inferSelect) {
  const csrSettings = s as AdminSettingsWithCsr;
  const aiPrompt = s.aiConciergePrompt ?? null;
  return {
    id: s.id,
    orderRoutingRule: (s.orderRoutingRule ?? "round_robin") as RoutingRule,
    defaultEtaMinutes: s.defaultEtaMinutes ?? 30,
    menuImportEnabled: s.menuImportEnabled,
    showOutOfStock: s.showOutOfStock,
    enabledProcessors: s.enabledProcessors,
    checkoutConversionPreview: s.checkoutConversionPreview,
    merchantImageEnabled: s.merchantImageEnabled,
    merchantProcessorConfig: parseMerchantProcessorConfig(s.merchantProcessorConfig),
    autoPrintOnPayment: s.autoPrintOnPayment,
    receiptTemplateStyle: s.receiptTemplateStyle,
    labelTemplateStyle: s.labelTemplateStyle,
    purgeMode: s.purgeMode,
    purgeDelayHours: s.purgeDelayHours,
    keepAuditToken: s.keepAuditToken,
    keepFailedPaymentLogs: s.keepFailedPaymentLogs,
    receiptLineNameMode: s.receiptLineNameMode ?? "lucifer_only",
    aiConciergePrompt: aiPrompt,
    aiConciergePromptIsDefault: aiPrompt === null || aiPrompt.trim() === "",
    catalogBannerImages: parseCatalogBannerImages(s.catalogBannerImages),
    // WooCommerce — secrets are returned as a boolean mask only,
    // never echoed back to the client in plaintext.
    wcStoreUrl: s.wcStoreUrl ?? "https://lucifercruz.com",
    wcConsumerKeySet: !!s.wcConsumerKey,
    wcConsumerSecretSet: !!s.wcConsumerSecret,
    wcEnabled: s.wcEnabled ?? true,
    pickupInstructionOptions: parsePickupInstructions(s.pickupInstructionOptions),
    shiftLocationOptions: parseShiftLocations(csrSettings.shiftLocationOptions),
    deliveryOptions: parseDeliveryOptions(csrSettings.deliveryOptions),
    printerNetworkConfig: parsePrinterNetworkConfig(s.printerNetworkConfig),
    privacyModeEnabled: s.privacyModeEnabled ?? true,
    sensitiveScreensProtectionEnabled: s.sensitiveScreensProtectionEnabled ?? true,
    watermarkSensitiveScreens: s.watermarkSensitiveScreens ?? true,
    privacyBlurOnBackground: s.privacyBlurOnBackground ?? true,
    privacyPrintBlockingEnabled: s.privacyPrintBlockingEnabled ?? true,
    privacyProtectedRoles: s.privacyProtectedRoles ?? ["user", "csr", "supervisor", "admin", "global_admin"],
    customerDisclaimerText: s.customerDisclaimerText,
    customerDisclaimerVersion: s.customerDisclaimerVersion ?? 1,
    updatedAt: s.updatedAt,
  };
}

const DEFAULT_CATALOG_BANNERS = [
  "/banners/banner1.png",
  "/banners/banner2.png",
  "/banners/banner3.png",
];

function parseCatalogBannerImages(raw: string | null | undefined) {
  if (!raw) return DEFAULT_CATALOG_BANNERS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_CATALOG_BANNERS;
    const values = parsed
      .map((value) => typeof value === "string" ? value.trim() : "")
      .filter(Boolean)
      .slice(0, 6);
    return values.length ? values : DEFAULT_CATALOG_BANNERS;
  } catch {
    return DEFAULT_CATALOG_BANNERS;
  }
}

const DEFAULT_PICKUP_INSTRUCTIONS = [
  { id: "front-counter", label: "Front Counter", instructions: "Please come to the front counter and show your order confirmation." },
  { id: "side-door", label: "Side Door", instructions: "Please wait by the side-door pickup area and have your order confirmation ready." },
  { id: "courier-handoff", label: "Courier Handoff", instructions: "Your order will be handed to the assigned courier at the pickup location." },
];

const DEFAULT_SHIFT_LOCATIONS = [
  { id: "sales-box-1", label: "CSR Sales Box 1", address: "", pickupInstructionId: "front-counter", deliveryOptionId: "pickup" },
  { id: "sales-box-2", label: "CSR Sales Box 2", address: "", pickupInstructionId: "front-counter", deliveryOptionId: "pickup" },
  { id: "storefront", label: "Storefront", address: "", pickupInstructionId: "front-counter", deliveryOptionId: "pickup" },
  { id: "backstock", label: "Backstock", address: "", pickupInstructionId: "courier-handoff", deliveryOptionId: "delivery" },
];

const DEFAULT_UBER_STEPS = [
  "Select 'Uber Courier Delivery' for your order.",
  "Place your order to get it paid and receive a confirmation number.",
  "Wait until your order is marked Ready — the countdown is on your Orders screen.",
  "Once Ready, open the Uber app and request a Courier pickup to the order location.",
  "Ensure the car and arrival time are confirmed. When the car arrives, hand off to the driver.",
  "Promptly receive your package. DO NOT HAVE THE DRIVER WAIT!",
];

const DEFAULT_DELIVERY_OPTIONS = [
  { id: "pickup", label: "Customer Pickup", instructions: "Customer picks up the order at the selected location.", separatePaymentRequired: false, uberSteps: [] as string[] },
  { id: "uber_courier", label: "Uber Courier Delivery", instructions: "Delivery is ONLY available when arranged with Uber Courier. You will place your own Uber Courier request after the order is ready.", separatePaymentRequired: false, uberSteps: DEFAULT_UBER_STEPS },
  { id: "csr_delivery", label: "CSR Personal Delivery", instructions: "The CSR on duty will personally deliver your order. Only available within 2 miles. Delivery fee: $6 + 3% of sale total — goes entirely to your CSR as a gratuity.", separatePaymentRequired: false, uberSteps: [] as string[] },
];

function parsePickupInstructions(raw: string | null | undefined) {
  if (!raw) return DEFAULT_PICKUP_INSTRUCTIONS;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULT_PICKUP_INSTRUCTIONS;
  } catch {
    return DEFAULT_PICKUP_INSTRUCTIONS;
  }
}

function parseShiftLocations(raw: string | null | undefined) {
  if (!raw) return DEFAULT_SHIFT_LOCATIONS;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULT_SHIFT_LOCATIONS;
  } catch {
    return DEFAULT_SHIFT_LOCATIONS;
  }
}

function parseDeliveryOptions(raw: string | null | undefined) {
  if (!raw) return DEFAULT_DELIVERY_OPTIONS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_DELIVERY_OPTIONS;
    return parsed.map((o: Record<string, unknown>) => ({
      id: String(o.id ?? ""),
      label: String(o.label ?? ""),
      instructions: String(o.instructions ?? ""),
      separatePaymentRequired: o.separatePaymentRequired === true,
      uberSteps: Array.isArray(o.uberSteps)
        ? (o.uberSteps as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    }));
  } catch {
    return DEFAULT_DELIVERY_OPTIONS;
  }
}

const DEFAULT_MERCHANT_PROCESSOR_CONFIG: Record<string, Record<string, unknown>> = {
  stripe: { displayName: "Stripe", accountId: "", publicKey: "", webhookConfigured: false, notes: "" },
  apple_pay: { displayName: "Apple Pay", accountId: "", publicKey: "", webhookConfigured: false, notes: "" },
  cashapp: { displayName: "Cash App", accountId: "", publicKey: "", webhookConfigured: false, notes: "" },
  venmo: { displayName: "Venmo", accountId: "", publicKey: "", webhookConfigured: false, notes: "" },
  paypal: { displayName: "PayPal", accountId: "", publicKey: "", webhookConfigured: false, notes: "" },
  cash: { displayName: "Cash", accountId: "", publicKey: "", webhookConfigured: false, notes: "Cash is collected by the active CSR and reconciled at shift close." },
};

function parseMerchantProcessorConfig(raw: string | null | undefined) {
  if (!raw) return DEFAULT_MERCHANT_PROCESSOR_CONFIG;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_MERCHANT_PROCESSOR_CONFIG;
    return { ...DEFAULT_MERCHANT_PROCESSOR_CONFIG, ...parsed };
  } catch {
    return DEFAULT_MERCHANT_PROCESSOR_CONFIG;
  }
}

function cleanMerchantProcessorConfig(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_MERCHANT_PROCESSOR_CONFIG;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z0-9_]+$/.test(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    out[key] = {
      displayName: String(row.displayName ?? key).slice(0, 80),
      accountId: String(row.accountId ?? "").slice(0, 200),
      publicKey: String(row.publicKey ?? "").slice(0, 500),
      webhookConfigured: row.webhookConfigured === true,
      notes: String(row.notes ?? "").slice(0, 1000),
    };
  }
  return { ...DEFAULT_MERCHANT_PROCESSOR_CONFIG, ...out };
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

function parseStoredPrinterNetworkConfig(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}


const CUSTOMER_DISCLAIMER_MAX_CHARS = 5000;

function validateExactKeys(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  const allowedSet = new Set(allowed);
  return Object.keys(body).find((key) => !allowedSet.has(key)) ?? null;
}

function isCustomerRole(role: string | null | undefined): boolean {
  return (role ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_") === "user";
}

async function resolveSettingsTenantId(actor?: { tenantId?: number | null; role?: string | null }): Promise<number> {
  if (actor && !isGlobalAdmin({ role: actor.role ?? "user" }) && actor.tenantId != null) return actor.tenantId;
  return getHouseTenantId();
}

async function getTenantScopedSettingsForActor(actor: { tenantId?: number | null; role?: string | null }, createIfMissing = true) {
  await ensureAdminSettingsSchema();
  if (isGlobalAdmin({ role: actor.role ?? "user" })) return getOrCreateSettings(actor);
  if (actor.tenantId == null) return null;
  const [existing] = await db.select().from(adminSettingsTable).where(eq(adminSettingsTable.tenantId, actor.tenantId)).limit(1);
  if (existing) return existing;
  if (!createIfMissing) return null;
  const [created] = await db.insert(adminSettingsTable).values({ tenantId: actor.tenantId }).returning();
  return created;
}

async function getCurrentDisclaimerAcceptance(tenantId: number, userId: number, version: number) {
  const [acceptance] = await db.select().from(customerDisclaimerAcceptancesTable).where(and(
    eq(customerDisclaimerAcceptancesTable.tenantId, tenantId),
    eq(customerDisclaimerAcceptancesTable.userId, userId),
    eq(customerDisclaimerAcceptancesTable.disclaimerVersion, version),
  )).limit(1);
  return acceptance ?? null;
}

// Single-tenant: use the one global settings row, creating it if absent
async function getOrCreateSettings(actor?: { tenantId?: number | null; role?: string | null }) {
  await ensureAdminSettingsSchema();
  const tenantId = await resolveSettingsTenantId(actor);
  const [existing] = await db
    .select()
    .from(adminSettingsTable)
    .where(eq(adminSettingsTable.tenantId, tenantId))
    .limit(1);
  if (existing) return existing;
  const [created] = await db.insert(adminSettingsTable).values({ tenantId }).returning();
  return created;
}

/**
 * Decrypt the WooCommerce credentials stored on a settings row.
 * Returns null for either field if decryption fails or the column is empty.
 * Used by the woocommerce route to load creds for syncs / connection tests.
 */
async function getDecryptedWooCreds(): Promise<{
  storeUrl: string;
  consumerKey: string | null;
  consumerSecret: string | null;
  enabled: boolean;
}> {
  const s = await getOrCreateSettings();
  return {
    storeUrl: s.wcStoreUrl ?? "https://lucifercruz.com",
    consumerKey: safeDecrypt(s.wcConsumerKey),
    consumerSecret: safeDecrypt(s.wcConsumerSecret),
    enabled: s.wcEnabled ?? true,
  };
}


// GET /api/customer/disclaimer — current tenant-scoped disclaimer and acceptance state
router.get("/customer/disclaimer", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  if (actor.tenantId == null) {
    res.status(403).json({ error: "Customer disclaimer requires a tenant assignment" });
    return;
  }
  const settings = await getTenantScopedSettingsForActor(actor, false);
  if (!settings || settings.tenantId !== actor.tenantId) {
    res.status(403).json({ error: "Forbidden: tenant mismatch" });
    return;
  }
  const version = settings.customerDisclaimerVersion ?? 1;
  const acceptance = await getCurrentDisclaimerAcceptance(actor.tenantId, actor.id, version);
  res.json({
    text: settings.customerDisclaimerText,
    version,
    accepted: !!acceptance,
    acceptedAt: acceptance?.acceptedAt ?? null,
    required: isCustomerRole(actor.role) && !acceptance,
  });
});

// POST /api/customer/disclaimer/accept — accepts current version for authenticated user only
router.post("/customer/disclaimer/accept", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const unknown = validateExactKeys(body, ["version"]);
  if (unknown) {
    res.status(400).json({ error: `Unknown field: ${unknown}` });
    return;
  }
  if (!Number.isInteger(body.version) || Number(body.version) < 1) {
    res.status(400).json({ error: "version must be a positive integer" });
    return;
  }
  const actor = req.dbUser!;
  if (actor.tenantId == null) {
    res.status(403).json({ error: "Customer disclaimer requires a tenant assignment" });
    return;
  }
  const settings = await getTenantScopedSettingsForActor(actor, false);
  const currentVersion = settings?.customerDisclaimerVersion ?? 1;
  if (!settings || settings.tenantId !== actor.tenantId || body.version !== currentVersion) {
    res.status(409).json({ error: "Disclaimer version is no longer current", currentVersion });
    return;
  }
  const existing = await getCurrentDisclaimerAcceptance(actor.tenantId, actor.id, currentVersion);
  if (existing) {
    res.json({ accepted: true, version: currentVersion, acceptedAt: existing.acceptedAt });
    return;
  }
  const [created] = await db.insert(customerDisclaimerAcceptancesTable).values({
    tenantId: actor.tenantId,
    userId: actor.id,
    disclaimerVersion: currentVersion,
  }).returning();
  res.status(201).json({ accepted: true, version: currentVersion, acceptedAt: created.acceptedAt });
});

// GET /api/admin/settings/customer-disclaimer
router.get("/admin/settings/customer-disclaimer", requireRole("global_admin", "admin", "supervisor"), requireTenantAssignedOrGlobal, async (req, res): Promise<void> => {
  const settings = await getTenantScopedSettingsForActor(req.dbUser!);
  if (!settings) {
    res.status(403).json({ error: "Tenant-scoped settings access requires a tenant assignment" });
    return;
  }
  res.json({ text: settings.customerDisclaimerText, version: settings.customerDisclaimerVersion ?? 1, updatedAt: settings.updatedAt });
});

// PUT /api/admin/settings/customer-disclaimer
router.put("/admin/settings/customer-disclaimer", requireRole("global_admin", "admin", "supervisor"), requireTenantAssignedOrGlobal, async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const unknown = validateExactKeys(body, ["text"]);
  if (unknown) {
    res.status(400).json({ error: `Unknown field: ${unknown}` });
    return;
  }
  if (typeof body.text !== "string") {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const text = body.text.trim();
  if (text.length < 20 || text.length > CUSTOMER_DISCLAIMER_MAX_CHARS) {
    res.status(400).json({ error: `text must be between 20 and ${CUSTOMER_DISCLAIMER_MAX_CHARS} characters` });
    return;
  }
  const settings = await getTenantScopedSettingsForActor(req.dbUser!);
  if (!settings) {
    res.status(403).json({ error: "Tenant-scoped settings access requires a tenant assignment" });
    return;
  }
  const changed = text !== settings.customerDisclaimerText;
  const nextVersion = changed ? (settings.customerDisclaimerVersion ?? 1) + 1 : (settings.customerDisclaimerVersion ?? 1);
  const [updated] = await db.update(adminSettingsTable).set({
    customerDisclaimerText: text,
    customerDisclaimerVersion: nextVersion,
    updatedAt: new Date(),
  }).where(eq(adminSettingsTable.id, settings.id)).returning();
  await writeAuditLog({
    actorId: req.dbUser!.id,
    actorEmail: req.dbUser!.email,
    actorRole: req.dbUser!.role,
    tenantId: updated.tenantId,
    action: "settings.customer_disclaimer.updated",
    resourceType: "admin_settings",
    resourceId: String(updated.id),
    metadata: { previousVersion: settings.customerDisclaimerVersion ?? 1, version: nextVersion, changed },
    ipAddress: req.ip,
  });
  res.json({ text: updated.customerDisclaimerText, version: updated.customerDisclaimerVersion ?? 1, updatedAt: updated.updatedAt });
});

// GET /api/admin/settings
router.get("/admin/settings", requirePermission("settings.view"), requireTenantAssignedOrGlobal, async (_req, res): Promise<void> => {
  const s = await getOrCreateSettings(_req.dbUser);
  res.json(mapSettings(s));
});

// PUT /api/admin/settings
router.put("/admin/settings", requirePermission("settings.manage_tenant"), requireTenantAssignedOrGlobal, async (req, res): Promise<void> => {
  const allowed = [
    "menuImportEnabled", "showOutOfStock", "enabledProcessors",
    "checkoutConversionPreview", "merchantImageEnabled", "autoPrintOnPayment",
    "receiptTemplateStyle", "labelTemplateStyle", "purgeMode",
    "purgeDelayHours", "keepAuditToken", "keepFailedPaymentLogs",
    "receiptLineNameMode",
    "privacyModeEnabled", "sensitiveScreensProtectionEnabled", "watermarkSensitiveScreens",
    "privacyBlurOnBackground", "privacyPrintBlockingEnabled", "privacyProtectedRoles",
  ];
  const body = (req.body ?? {}) as Record<string, unknown>;
  const update: Record<string, unknown> = {};
  for (const k of allowed) {
    if (body[k] !== undefined) update[k] = body[k];
  }
  if (body.catalogBannerImages !== undefined) {
    if (!Array.isArray(body.catalogBannerImages)) {
      res.status(400).json({ error: "catalogBannerImages must be an array of image URLs" });
      return;
    }
    const banners = body.catalogBannerImages
      .map((value) => typeof value === "string" ? value.trim() : "")
      .filter(Boolean)
      .slice(0, 6);
    update.catalogBannerImages = JSON.stringify(banners.length ? banners : DEFAULT_CATALOG_BANNERS);
  }
  if (body.merchantProcessorConfig !== undefined) {
    update.merchantProcessorConfig = JSON.stringify(cleanMerchantProcessorConfig(body.merchantProcessorConfig));
  }

  if (body.orderRoutingRule !== undefined) {
    if (typeof body.orderRoutingRule !== "string" || !(ROUTING_RULES as readonly string[]).includes(body.orderRoutingRule)) {
      res.status(400).json({ error: `orderRoutingRule must be one of ${ROUTING_RULES.join(", ")}` });
      return;
    }
    update.orderRoutingRule = body.orderRoutingRule;
  }
  if (body.defaultEtaMinutes !== undefined) {
    const n = Number(body.defaultEtaMinutes);
    if (!Number.isInteger(n) || n < 1) {
      res.status(400).json({ error: "defaultEtaMinutes must be a positive integer" });
      return;
    }
    update.defaultEtaMinutes = n;
  }
  if (body.aiConciergePrompt !== undefined) {
    if (body.aiConciergePrompt === null) {
      update.aiConciergePrompt = null;
    } else if (typeof body.aiConciergePrompt !== "string") {
      res.status(400).json({ error: "aiConciergePrompt must be a string or null" });
      return;
    } else {
      const trimmed = body.aiConciergePrompt.trim();
      if (trimmed.length === 0) {
        // Empty string === revert to default.
        update.aiConciergePrompt = null;
      } else if (body.aiConciergePrompt.length > AI_CONCIERGE_PROMPT_MAX_CHARS) {
        res.status(400).json({
          error: `aiConciergePrompt exceeds maximum length of ${AI_CONCIERGE_PROMPT_MAX_CHARS} characters`,
        });
        return;
      } else {
        update.aiConciergePrompt = body.aiConciergePrompt;
      }
    }
  }

  const existing = await getOrCreateSettings(req.dbUser);
  if (Object.keys(update).length === 0) {
    res.json(mapSettings(existing));
    return;
  }
  const [updated] = await db.update(adminSettingsTable)
    .set(update)
    .where(and(eq(adminSettingsTable.id, existing.id), eq(adminSettingsTable.tenantId, existing.tenantId)))
    .returning();
  res.json(mapSettings(updated));
});

/**
 * GET /api/admin/settings/woocommerce
 * Returns the WC config in masked form. Secrets are NEVER returned in plaintext —
 * only boolean flags indicating whether they have been saved.
 */
router.get("/admin/settings/woocommerce", requirePermission("settings.view"), requireTenantAssignedOrGlobal, async (_req, res): Promise<void> => {
  const s = await getOrCreateSettings(_req.dbUser);
  res.json({
    wc_store_url: s.wcStoreUrl ?? "https://lucifercruz.com",
    wcStoreUrl: s.wcStoreUrl ?? "https://lucifercruz.com",
    enabled: s.wcEnabled ?? true,
    hasConsumerKey: !!s.wcConsumerKey,
    hasConsumerSecret: !!s.wcConsumerSecret,
    wcConsumerKeySet: !!s.wcConsumerKey,
    wcConsumerSecretSet: !!s.wcConsumerSecret,
    wcEnabled: s.wcEnabled ?? true,
  });
});

/**
 * PUT /api/admin/settings/woocommerce — save WooCommerce credentials.
 * Secrets are encrypted at rest using AES-256-GCM keyed off SETTINGS_ENC_KEY.
 * They are never echoed back to the client.
 */
router.put("/admin/settings/woocommerce", requirePermission("settings.manage_tenant"), requireTenantAssignedOrGlobal, async (req, res): Promise<void> => {
  try {
    const body = (req.body ?? {}) as {
      wcStoreUrl?: string; wc_store_url?: string;
      wcConsumerKey?: string; wc_consumer_key?: string;
      wcConsumerSecret?: string; wc_consumer_secret?: string;
      enabled?: boolean; wcEnabled?: boolean;
    };

    const storeUrl = body.wcStoreUrl ?? body.wc_store_url;
    const consumerKey = body.wcConsumerKey ?? body.wc_consumer_key;
    const consumerSecret = body.wcConsumerSecret ?? body.wc_consumer_secret;
    const enabled = body.enabled ?? body.wcEnabled;

    const update: Record<string, unknown> = {};
    if (storeUrl !== undefined) {
      const trimmed = String(storeUrl).trim();
      update["wcStoreUrl"] = trimmed || "https://lucifercruz.com";
    }
    if (consumerKey !== undefined) {
      const trimmed = String(consumerKey).trim();
      update["wcConsumerKey"] = trimmed ? encrypt(trimmed) : null;
    }
    if (consumerSecret !== undefined) {
      const trimmed = String(consumerSecret).trim();
      update["wcConsumerSecret"] = trimmed ? encrypt(trimmed) : null;
    }
    if (enabled !== undefined) {
      update["wcEnabled"] = !!enabled;
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "No fields provided" });
      return;
    }

    const existing = await getOrCreateSettings(req.dbUser);
    const [updated] = await db.update(adminSettingsTable)
      .set(update)
      .where(eq(adminSettingsTable.id, existing.id))
      .returning();
    res.json(mapSettings(updated));
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message ?? "Failed to save WooCommerce settings" });
  }
});

// ─── CSR / Pickup / Printer Network Settings ─────────────────────────────────

router.get("/admin/csr-settings", requireRole("global_admin", "admin", "csr"), async (_req, res): Promise<void> => {
  const s = await getOrCreateSettings() as AdminSettingsWithCsr;
  res.json({
    pickupInstructionOptions: parsePickupInstructions(s.pickupInstructionOptions),
    shiftLocationOptions: parseShiftLocations(s.shiftLocationOptions),
    deliveryOptions: parseDeliveryOptions(s.deliveryOptions),
    printerNetworkConfig: parsePrinterNetworkConfig(s.printerNetworkConfig),
  });
});

router.put("/admin/csr-settings", requireRole("global_admin", "admin", "supervisor"), async (req, res): Promise<void> => {
  const pickupInstructionOptions = req.body?.pickupInstructionOptions;
  const shiftLocationOptions = req.body?.shiftLocationOptions;
  const deliveryOptions = req.body?.deliveryOptions;
  const printerNetworkConfig = req.body?.printerNetworkConfig;
  const update: Record<string, unknown> = {};
  const existing = await getOrCreateSettings() as AdminSettingsWithCsr;

  if (pickupInstructionOptions !== undefined) {
    if (!Array.isArray(pickupInstructionOptions) || pickupInstructionOptions.length > 20) {
      res.status(400).json({ error: "pickupInstructionOptions must be an array of up to 20 options" });
      return;
    }
    update.pickupInstructionOptions = JSON.stringify(pickupInstructionOptions.map((option, index) => ({
      id: String(option.id || `pickup-${index + 1}`),
      label: String(option.label || "Pickup option"),
      instructions: String(option.instructions || option.address || ""),
    })));
  }

  if (shiftLocationOptions !== undefined) {
    if (!Array.isArray(shiftLocationOptions) || shiftLocationOptions.length > 20) {
      res.status(400).json({ error: "shiftLocationOptions must be an array of up to 20 locations" });
      return;
    }
    update.shiftLocationOptions = JSON.stringify(shiftLocationOptions.map((option, index) => ({
      id: String(option.id || `location-${index + 1}`),
      label: String(option.label || "Shift location"),
      address: String(option.address || ""),
      pickupInstructionId: String(option.pickupInstructionId || ""),
      deliveryOptionId: String(option.deliveryOptionId || ""),
    })));
  }

  if (deliveryOptions !== undefined) {
    if (!Array.isArray(deliveryOptions) || deliveryOptions.length > 20) {
      res.status(400).json({ error: "deliveryOptions must be an array of up to 20 options" });
      return;
    }
    update.deliveryOptions = JSON.stringify(deliveryOptions.map((option, index) => ({
      id: String(option.id || `delivery-${index + 1}`),
      label: String(option.label || "Delivery option"),
      instructions: String(option.instructions || ""),
      separatePaymentRequired: option.separatePaymentRequired === true,
      uberSteps: Array.isArray(option.uberSteps)
        ? (option.uberSteps as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 20)
        : [],
    })));
  }

  if (printerNetworkConfig !== undefined) {
    const cfg = printerNetworkConfig as Record<string, unknown>;
    const storedCfg = parseStoredPrinterNetworkConfig(existing.printerNetworkConfig);
    const approvedSsids = Array.isArray(cfg.approvedSsids)
      ? (cfg.approvedSsids as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 10)
      : (typeof cfg.ssid === "string" && cfg.ssid.trim() ? [cfg.ssid.trim()] : []);
    update.printerNetworkConfig = JSON.stringify({
      onsiteMode: String(cfg.onsiteMode || "auto"),
      ssid: String(cfg.ssid || ""),
      approvedSsids,
      password: typeof cfg.password === "string" ? cfg.password : String(storedCfg.password || ""),
      raspberryPiBluetooth: cfg.raspberryPiBluetooth !== false,
    });
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: "No fields provided" });
    return;
  }

  const [updated] = await db.update(adminSettingsTable)
    .set(update)
    .where(eq(adminSettingsTable.id, existing.id))
    .returning() as AdminSettingsWithCsr[];
  res.json({
    pickupInstructionOptions: parsePickupInstructions(updated.pickupInstructionOptions),
    shiftLocationOptions: parseShiftLocations(updated.shiftLocationOptions),
    deliveryOptions: parseDeliveryOptions(updated.deliveryOptions),
    printerNetworkConfig: parsePrinterNetworkConfig(updated.printerNetworkConfig),
  });
});

// ─── Concierge Promoted Items ─────────────────────────────────────────────────

function parseIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

// GET /api/concierge/promoted — authenticated users: returns full catalog items
router.get("/concierge/promoted", async (req, res): Promise<void> => {
  const s = await getOrCreateSettings(req.dbUser);
  const ids = parseIds(s.conciergePromotedItemIds);
  if (ids.length === 0) { res.json([]); return; }
  const { catalogItemsTable } = await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");
  const rows = await db.select().from(catalogItemsTable).where(inArray(catalogItemsTable.id, ids));
  const ordered = ids.map(id => rows.find(r => r.id === id)).filter(Boolean);
  res.json(ordered.map(i => ({
    id: i!.id,
    name: i!.alavontName ?? i!.name,
    category: i!.alavontCategory ?? i!.category,
    price: parseFloat(i!.price as string),
    imageUrl: i!.alavontImageUrl ?? i!.imageUrl ?? null,
    isAvailable: i!.isAvailable,
  })));
});

// GET /api/admin/concierge/promoted — admin/supervisor: returns IDs
router.get("/admin/concierge/promoted", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  const s = await getOrCreateSettings(req.dbUser);
  res.json({ ids: parseIds(s.conciergePromotedItemIds) });
});

// PUT /api/admin/concierge/promoted — admin: sets promoted item IDs
router.put("/admin/concierge/promoted", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length > 8 || !ids.every(x => Number.isInteger(x) && x > 0)) {
    res.status(400).json({ error: "ids must be an array of up to 8 positive integers" });
    return;
  }
  const existing = await getOrCreateSettings(req.dbUser);
  await db.update(adminSettingsTable)
    .set({ conciergePromotedItemIds: JSON.stringify(ids) })
    .where(and(eq(adminSettingsTable.id, existing.id), eq(adminSettingsTable.tenantId, existing.tenantId)));
  res.json({ ids });
});

// ─── Concierge Intro Steps ────────────────────────────────────────────────────

const DEFAULT_CONCIERGE_STEPS = [
  { emoji: "⚡", title: "Hey! I'm Zappy", body: "Your personal shopping buddy for everything at Alavont & Lucifer Cruz. No judgment, no awkwardness — just me helping you find what you need. I know this menu inside and out.", cta: "Let's go!" },
  { emoji: "🛍️", title: "Explore the Menu", body: "Browse hundreds of products by category or just tell me what you're into. Search it, ask me, or I'll recommend something that fits. We'll find it together.", cta: "Got it, nice!" },
  { emoji: "🛒", title: "Order Like a Pro", body: "Take a quick look at your cart before checking out. Double-check the details — quantities, product names, the works. Once it's in, it's in. No stress though, I got you.", cta: "Sounds good!" },
  { emoji: "📱", title: "Track It & Chill", body: "After checkout, updates come straight here — no calls needed. Sit back, relax. When your order's ready, you'll know. I'll be here if you need anything else.", cta: "I'm ready ⚡" },
];

function parseSteps(raw: string | null | undefined) {
  if (!raw) return DEFAULT_CONCIERGE_STEPS;
  try { return JSON.parse(raw); } catch { return DEFAULT_CONCIERGE_STEPS; }
}

const conciergeStepSchema = z.object({
  emoji: z.string().trim().min(1).max(16),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(1000),
  cta: z.string().trim().min(1).max(80),
}).strict();

const conciergeStepsSchema = z.array(conciergeStepSchema).min(1).max(8);

// GET /api/concierge/intro-steps — any authenticated user
router.get("/concierge/intro-steps", async (req, res): Promise<void> => {
  const s = await getOrCreateSettings(req.dbUser);
  res.json(parseSteps(s.conciergeIntroSteps));
});

// GET /api/admin/concierge-steps — admin/supervisor read
router.get("/admin/concierge-steps", requireRole("global_admin", "admin", "supervisor"), async (req, res): Promise<void> => {
  const s = await getOrCreateSettings(req.dbUser);
  res.json(parseSteps(s.conciergeIntroSteps));
});

// PUT /api/admin/concierge-steps — supervisor/admin/global_admin only
router.put("/admin/concierge-steps", requireRole("global_admin", "admin", "supervisor"), async (req, res): Promise<void> => {
  const parsed = conciergeStepsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid concierge steps payload", issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
    return;
  }
  const existing = await getOrCreateSettings(req.dbUser);
  const [updated] = await db.update(adminSettingsTable)
    .set({ conciergeIntroSteps: JSON.stringify(parsed.data) })
    .where(and(eq(adminSettingsTable.id, existing.id), eq(adminSettingsTable.tenantId, existing.tenantId)))
    .returning();
  void writeAuditLog({
    actorId: req.dbUser!.id,
    actorEmail: req.dbUser!.email,
    actorRole: req.dbUser!.role,
    action: "settings.ai_concierge_steps_updated",
    tenantId: existing.tenantId,
    resourceType: "admin_settings",
    resourceId: String(existing.id),
    metadata: { stepCount: parsed.data.length },
    ipAddress: req.ip,
  });
  res.json(parseSteps(updated.conciergeIntroSteps));
});

export { getOrCreateSettings, getDecryptedWooCreds };
export default router;
