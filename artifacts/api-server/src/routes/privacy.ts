import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db, adminSettingsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole, writeAuditLog } from "../lib/auth";

const router: IRouter = Router();

const EVENTS = ["sensitive_screen_viewed", "sensitive_screen_hidden_on_blur", "print_attempt", "screenshot_key_attempt", "context_menu_blocked"] as const;
const eventSchema = z.object({ eventType: z.enum(EVENTS), route: z.string().trim().min(1).max(300) }).strict();
const settingsSchema = z.object({
  privacyModeEnabled: z.boolean(),
  sensitiveScreensProtectionEnabled: z.boolean(),
  watermarkSensitiveScreens: z.boolean(),
  privacyBlurOnBackground: z.boolean(),
  privacyPrintBlockingEnabled: z.boolean(),
  privacyProtectedRoles: z.array(z.enum(["user", "csr", "supervisor", "admin", "global_admin"])).max(5),
}).strict();

const privacyRateLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

let privacySettingsSchemaEnsured = false;
async function ensurePrivacySettingsSchema() {
  if (privacySettingsSchemaEnsured) return;
  await db.execute(sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "privacy_mode_enabled" boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "sensitive_screens_protection_enabled" boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "watermark_sensitive_screens" boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "privacy_blur_on_background" boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "privacy_print_blocking_enabled" boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "privacy_protected_roles" text[] NOT NULL DEFAULT ARRAY['user','csr','supervisor','admin','global_admin']::text[]`);
  privacySettingsSchemaEnsured = true;
}

router.post("/privacy/events", privacyRateLimit, async (req, res): Promise<void> => {
  const parsed = eventSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid privacy event payload" }); return; }
  const user = req.dbUser!;
  await writeAuditLog({
    actorId: user.id,
    actorEmail: user.email,
    actorRole: user.role ?? "user",
    tenantId: user.tenantId,
    action: `privacy.${parsed.data.eventType}`,
    resourceType: "privacy_event",
    resourceId: parsed.data.route,
    metadata: { route: parsed.data.route, userAgent: req.get("user-agent") ?? null },
    ipAddress: req.ip,
  });
  res.status(204).end();
});

function mapPrivacySettings(row: Record<string, unknown>) {
  return {
    privacyModeEnabled: row.privacyModeEnabled ?? true,
    sensitiveScreensProtectionEnabled: row.sensitiveScreensProtectionEnabled ?? true,
    watermarkSensitiveScreens: row.watermarkSensitiveScreens ?? true,
    privacyBlurOnBackground: row.privacyBlurOnBackground ?? true,
    privacyPrintBlockingEnabled: row.privacyPrintBlockingEnabled ?? true,
    privacyProtectedRoles: row.privacyProtectedRoles ?? ["user", "csr", "supervisor", "admin", "global_admin"],
  };
}

async function getTenantSettings(tenantId: number) {
  await ensurePrivacySettingsSchema();
  const [existing] = await db.select().from(adminSettingsTable).where(eq(adminSettingsTable.tenantId, tenantId)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(adminSettingsTable).values({ tenantId }).returning();
  return created;
}

router.get("/admin/privacy-settings", async (req, res): Promise<void> => {
  const tenantId = req.dbUser!.tenantId;
  if (!tenantId) { res.status(403).json({ error: "Tenant assignment required" }); return; }
  const settings = await getTenantSettings(tenantId);
  res.json(mapPrivacySettings(settings as unknown as Record<string, unknown>));
});

router.put("/admin/privacy-settings", requireRole("admin", "global_admin"), async (req, res): Promise<void> => {
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid privacy settings payload" }); return; }
  const tenantId = req.dbUser!.tenantId;
  if (!tenantId) { res.status(403).json({ error: "Tenant assignment required" }); return; }
  const existing = await getTenantSettings(tenantId);
  const [updated] = await db.update(adminSettingsTable).set(parsed.data).where(eq(adminSettingsTable.id, existing.id)).returning();
  await writeAuditLog({ actorId: req.dbUser!.id, actorEmail: req.dbUser!.email, actorRole: req.dbUser!.role ?? "admin", tenantId, action: "privacy.settings_updated", resourceType: "admin_settings", resourceId: String(existing.id), metadata: { changedKeys: Object.keys(parsed.data) }, ipAddress: req.ip });
  res.json(mapPrivacySettings(updated as unknown as Record<string, unknown>));
});

export default router;
