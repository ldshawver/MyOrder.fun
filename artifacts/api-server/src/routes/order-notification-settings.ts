import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, auditLogsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";
import { requireTenantContext } from "../lib/tenantContext";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireTenantContext);
const admin = requireRole("global_admin", "admin");
const body = z.object({
  lightEnabled: z.boolean(), smsEnabled: z.boolean(),
  alertDurationSeconds: z.number().int().min(10).max(600),
  generalAssigneeUserId: z.number().int().positive().nullable(),
  generalFallbackUserId: z.number().int().positive().nullable(),
}).strict();
function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : ((value as { rows?: T[] } | undefined)?.rows ?? []);
}
const lightConfigured = (tenantId: number) => Number(process.env.TUYA_TENANT_ID) === tenantId &&
  !!process.env.TUYA_CLIENT_ID && !!process.env.TUYA_CLIENT_SECRET && !!process.env.TUYA_API_BASE_URL && !!process.env.TUYA_DEVICE_ID;
const smsConfigured = () => !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN && !!process.env.TWILIO_PHONE_NUMBER;

router.get("/admin/order-notifications", admin, async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!;
  const settings = rows<{
    lightEnabled: boolean; smsEnabled: boolean; alertDurationSeconds: number;
    generalAssigneeUserId: number | null; generalFallbackUserId: number | null;
  }>(await db.execute(sql`SELECT light_enabled AS "lightEnabled",sms_enabled AS "smsEnabled",
    alert_duration_seconds AS "alertDurationSeconds",general_assignee_user_id AS "generalAssigneeUserId",
    general_fallback_user_id AS "generalFallbackUserId" FROM order_notification_settings WHERE tenant_id=${tenantId}`))[0]
    ?? { lightEnabled: false, smsEnabled: false, alertDurationSeconds: 60, generalAssigneeUserId: null, generalFallbackUserId: null };
  const recipients = rows<{ id: number; label: string; role: string }>(await db.execute(sql`
    SELECT id,concat_ws(' ',first_name,last_name) AS label,role FROM users
    WHERE tenant_id=${tenantId} AND is_active=true AND status='approved' AND role IN ('admin','supervisor')
    ORDER BY id`));
  res.json({ settings, recipients, lightConfigured: lightConfigured(tenantId), smsConfigured: smsConfigured(), deviceAlias: "MyOrder.fun" });
});

router.put("/admin/order-notifications", admin, async (req, res): Promise<void> => {
  const parsed = body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const tenantId = req.authorizedTenantId!;
  const setting = parsed.data;
  if (setting.lightEnabled && !lightConfigured(tenantId)) { res.status(409).json({ error: "Order light service is not configured for this tenant" }); return; }
  if (setting.smsEnabled && !smsConfigured()) { res.status(409).json({ error: "Order SMS provider is not configured" }); return; }
  if (setting.smsEnabled && !setting.generalAssigneeUserId && !setting.generalFallbackUserId) {
    res.status(400).json({ error: "Configure a General Queue assignee or fallback before enabling SMS" }); return;
  }
  for (const userId of [setting.generalAssigneeUserId, setting.generalFallbackUserId]) {
    if (!userId) continue;
    const valid = rows<{ id: number }>(await db.execute(sql`SELECT id FROM users WHERE tenant_id=${tenantId} AND id=${userId}
      AND role IN ('admin','supervisor') AND is_active=true AND status='approved' LIMIT 1`));
    if (!valid.length) { res.status(400).json({ error: "General Queue recipient must be an active tenant Admin or Supervisor" }); return; }
  }
  const actor = req.dbUser!;
  await db.transaction(async tx => {
    await tx.execute(sql`INSERT INTO order_notification_settings(tenant_id,light_enabled,sms_enabled,alert_duration_seconds,
      general_assignee_user_id,general_fallback_user_id) VALUES(${tenantId},${setting.lightEnabled},${setting.smsEnabled},
      ${setting.alertDurationSeconds},${setting.generalAssigneeUserId},${setting.generalFallbackUserId})
      ON CONFLICT(tenant_id) DO UPDATE SET light_enabled=EXCLUDED.light_enabled,sms_enabled=EXCLUDED.sms_enabled,
      alert_duration_seconds=EXCLUDED.alert_duration_seconds,general_assignee_user_id=EXCLUDED.general_assignee_user_id,
      general_fallback_user_id=EXCLUDED.general_fallback_user_id,updated_at=now()`);
    await tx.insert(auditLogsTable).values({ tenantId, actorId: actor.id, actorEmail: actor.email ?? "", actorRole: actor.role,
      action: "order_notifications.settings_updated", resourceType: "order_notification_settings", resourceId: String(tenantId),
      metadata: { lightEnabled: setting.lightEnabled, smsEnabled: setting.smsEnabled,
        alertDurationSeconds: setting.alertDurationSeconds, generalAssigneeUserId: setting.generalAssigneeUserId,
        generalFallbackUserId: setting.generalFallbackUserId }, ipAddress: req.ip });
  });
  res.json({ settings: setting, lightConfigured: lightConfigured(tenantId), smsConfigured: smsConfigured(), deviceAlias: "MyOrder.fun" });
});

export default router;
