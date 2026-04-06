import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, adminSettingsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireRole } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser);

function mapSettings(s: typeof adminSettingsTable.$inferSelect) {
  return {
    id: s.id,
    tenantId: s.tenantId,
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
    updatedAt: s.updatedAt,
  };
}

async function getOrCreateSettings(tenantId: number) {
  const [existing] = await db.select().from(adminSettingsTable)
    .where(eq(adminSettingsTable.tenantId, tenantId)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(adminSettingsTable).values({ tenantId }).returning();
  return created;
}

// GET /api/admin/settings
router.get("/admin/settings", requireRole("tenant_admin", "global_admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  if (!actor.tenantId) { res.status(400).json({ error: "No tenant" }); return; }
  const s = await getOrCreateSettings(actor.tenantId);
  res.json(mapSettings(s));
});

// PUT /api/admin/settings
router.put("/admin/settings", requireRole("tenant_admin", "global_admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  if (!actor.tenantId) { res.status(400).json({ error: "No tenant" }); return; }

  const allowed = [
    "menuImportEnabled", "showOutOfStock", "enabledProcessors",
    "checkoutConversionPreview", "merchantImageEnabled", "autoPrintOnPayment",
    "receiptTemplateStyle", "labelTemplateStyle", "purgeMode",
    "purgeDelayHours", "keepAuditToken", "keepFailedPaymentLogs",
  ];
  const update: Record<string, unknown> = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) update[k] = req.body[k];
  }

  const existing = await getOrCreateSettings(actor.tenantId);
  const [updated] = await db.update(adminSettingsTable)
    .set(update)
    .where(eq(adminSettingsTable.id, existing.id))
    .returning();
  res.json(mapSettings(updated));
});

export { getOrCreateSettings };
export default router;
