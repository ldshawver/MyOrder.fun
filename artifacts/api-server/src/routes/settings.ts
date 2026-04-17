import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, adminSettingsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole, requireApproved } from "../lib/auth";
import { getHouseTenantId } from "../lib/singleTenant";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

function mapSettings(s: typeof adminSettingsTable.$inferSelect) {
  return {
    id: s.id,
    menuImportEnabled: s.menuImportEnabled,
    showOutOfStock: s.showOutOfStock,
    enabledProcessors: s.enabledProcessors,
    checkoutConversionPreview: s.checkoutConversionPreview,
    merchantImageEnabled: s.merchantImageEnabled,
    autoPrintOnPayment: s.autoPrintOnPayment,
    receiptTemplateStyle: s.receiptTemplateStyle,
    labelTemplateStyle: s.labelTemplateStyle,
    purgeMode: s.purgeMode,
    purgeDelayHours: s.purgeDelayHours,
    keepAuditToken: s.keepAuditToken,
    keepFailedPaymentLogs: s.keepFailedPaymentLogs,
    receiptLineNameMode: s.receiptLineNameMode ?? "lucifer_only",
    // WooCommerce — consumer key/secret are returned as a boolean mask only,
    // never echoed back to the client in plaintext.
    wcStoreUrl: s.wcStoreUrl ?? "https://lucifercruz.com",
    wcConsumerKeySet: !!s.wcConsumerKey,
    wcConsumerSecretSet: !!s.wcConsumerSecret,
    updatedAt: s.updatedAt,
  };
}

// Single-tenant: use the one global settings row, creating it if absent
async function getOrCreateSettings() {
  const [existing] = await db.select().from(adminSettingsTable).limit(1);
  if (existing) return existing;
  const tenantId = await getHouseTenantId();
  const [created] = await db.insert(adminSettingsTable).values({ tenantId }).returning();
  return created;
}

// GET /api/admin/settings
router.get("/admin/settings", requireRole("admin", "supervisor"), async (_req, res): Promise<void> => {
  const s = await getOrCreateSettings();
  res.json(mapSettings(s));
});

// PUT /api/admin/settings
router.put("/admin/settings", requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const allowed = [
    "menuImportEnabled", "showOutOfStock", "enabledProcessors",
    "checkoutConversionPreview", "merchantImageEnabled", "autoPrintOnPayment",
    "receiptTemplateStyle", "labelTemplateStyle", "purgeMode",
    "purgeDelayHours", "keepAuditToken", "keepFailedPaymentLogs",
    "receiptLineNameMode",
  ];
  const update: Record<string, unknown> = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) update[k] = req.body[k];
  }

  const existing = await getOrCreateSettings();
  const [updated] = await db.update(adminSettingsTable)
    .set(update)
    .where(eq(adminSettingsTable.id, existing.id))
    .returning();
  res.json(mapSettings(updated));
});

// PUT /api/admin/settings/woocommerce — save WooCommerce credentials
// Credentials are stored in the DB, never echoed back.
router.put("/admin/settings/woocommerce", requireRole("admin"), async (req, res): Promise<void> => {
  const { wcStoreUrl, wcConsumerKey, wcConsumerSecret } = req.body as {
    wcStoreUrl?: string;
    wcConsumerKey?: string;
    wcConsumerSecret?: string;
  };

  const update: Record<string, unknown> = {};
  if (wcStoreUrl !== undefined) update.wcStoreUrl = wcStoreUrl.trim() || "https://lucifercruz.com";
  if (wcConsumerKey !== undefined) update.wcConsumerKey = wcConsumerKey.trim() || null;
  if (wcConsumerSecret !== undefined) update.wcConsumerSecret = wcConsumerSecret.trim() || null;

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: "No fields provided" });
    return;
  }

  const existing = await getOrCreateSettings();
  const [updated] = await db.update(adminSettingsTable)
    .set(update)
    .where(eq(adminSettingsTable.id, existing.id))
    .returning();
  res.json(mapSettings(updated));
});

export { getOrCreateSettings };
export default router;
