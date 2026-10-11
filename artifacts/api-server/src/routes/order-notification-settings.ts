import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, auditLogsTable } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole, writeAuditLog } from "../lib/auth";
import { requireTenantContext } from "../lib/tenantContext";
import { encrypt, decrypt, hasConfiguredSettingsEncryptionKey } from "../lib/crypto";
import { getTuyaAccessToken, listTuyaDevices, sendTwilioSms, testTwilioConnection, setTuyaDeviceSwitch, type SmsCredentials, type TuyaCredentials, type TuyaRegion } from "../lib/notificationProviders";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved, requireTenantContext);
const admin = requireRole("global_admin", "admin");
const providerTestLimiter = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false });
const testMessageLimiter = rateLimit({ windowMs: 60_000, limit: 3, standardHeaders: true, legacyHeaders: false });
const body = z.object({
  lightEnabled: z.boolean(), smsEnabled: z.boolean(),
  alertDurationSeconds: z.number().int().min(10).max(600),
  generalAssigneeUserId: z.number().int().positive().nullable(),
  generalFallbackUserId: z.number().int().positive().nullable(),
}).strict();
function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : ((value as { rows?: T[] } | undefined)?.rows ?? []);
}
const SmsSettingsBody = z.object({ provider: z.literal("twilio").optional(), accountSid: z.string().trim().regex(/^AC[a-f0-9]{32}$/i).optional(), authToken: z.string().trim().min(16).max(256).optional(), sender: z.string().trim().regex(/^(\+[1-9]\d{7,14}|MG[a-f0-9]{32})$/i).optional() }).strict();
const TuyaSettingsBody = z.object({ clientId: z.string().trim().min(4).max(200).optional(), clientSecret: z.string().trim().min(16).max(512).optional(), region: z.enum(["us","eu","in","cn","ueaz","weaz"]).optional(), deviceId: z.string().trim().min(1).max(200).nullable().optional(), switchCode: z.string().trim().min(1).max(128).optional() }).strict();
const TestSmsBody = z.object({ to: z.string().trim().regex(/^\+[1-9]\d{7,14}$/) }).strict();
type NotificationProviderRow = { sms_provider: string; sms_sender: string | null; sms_credentials_ciphertext: string | null; sms_connection_status: string; tuya_region: string | null; tuya_device_id: string | null; tuya_switch_code: string | null; tuya_credentials_ciphertext: string | null; tuya_connection_status: string };
function safeJson(ciphertext: string | null): Record<string,string> | null { if (!ciphertext) return null; try { return JSON.parse(decrypt(ciphertext)) as Record<string,string>; } catch { return null; } }
async function providerRow(tenantId: number): Promise<NotificationProviderRow | undefined> {
  return (await db.execute(sql`SELECT sms_provider,sms_sender,sms_credentials_ciphertext,sms_connection_status,tuya_region,tuya_device_id,tuya_switch_code,tuya_credentials_ciphertext,tuya_connection_status FROM order_notification_settings WHERE tenant_id=${tenantId}`)).rows[0] as NotificationProviderRow | undefined;
}
function smsConfig(row: NotificationProviderRow | undefined): SmsCredentials | null {
  const value = safeJson(row?.sms_credentials_ciphertext ?? null);
  return value?.accountSid && value.authToken && row?.sms_sender ? { accountSid: value.accountSid, authToken: value.authToken, sender: row.sms_sender } : null;
}
function tuyaConfig(row: NotificationProviderRow | undefined): TuyaCredentials | null {
  const value = safeJson(row?.tuya_credentials_ciphertext ?? null);
  return value?.clientId && value.clientSecret && row?.tuya_region ? { clientId: value.clientId, clientSecret: value.clientSecret, region: row.tuya_region as TuyaRegion } : null;
}
const mask = (value: string | null | undefined) => value ? `••••${value.slice(-4)}` : null;
async function ensureRow(tenantId: number): Promise<void> {
  await db.execute(sql`INSERT INTO order_notification_settings(tenant_id) VALUES(${tenantId}) ON CONFLICT(tenant_id) DO NOTHING`);
}

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
  const provider = await providerRow(tenantId);
  const sms = smsConfig(provider); const tuya = tuyaConfig(provider);
  const deliveries = rows<{ notificationType: string; state: string; failureClass: string | null; maskedDestination: string | null; updatedAt: string }>(await db.execute(sql`
    SELECT notification_type AS "notificationType",state,failure_class AS "failureClass",masked_destination AS "maskedDestination",updated_at AS "updatedAt"
    FROM order_notification_jobs WHERE tenant_id=${tenantId} ORDER BY id DESC LIMIT 6`));
  res.json({ settings, recipients, lightConfigured: !!tuya && !!provider?.tuya_device_id && provider?.tuya_connection_status === "connected", smsConfigured: !!sms && provider?.sms_connection_status === "connected", deviceAlias: "MyOrder.fun",
    smsProvider: { provider: "twilio", configured: !!sms, connection: provider?.sms_connection_status ?? "not_configured", accountSidMasked: mask(sms?.accountSid), sender: mask(provider?.sms_sender) },
    tuyaProvider: { configured: !!tuya, connection: provider?.tuya_connection_status ?? "not_configured", clientIdMasked: mask(tuya?.clientId), region: provider?.tuya_region ?? null, deviceId: provider?.tuya_device_id ?? null, switchCode: provider?.tuya_switch_code ?? "switch_1" }, deliveries });
});

router.put("/admin/order-notifications", admin, async (req, res): Promise<void> => {
  const parsed = body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const tenantId = req.authorizedTenantId!;
  const setting = parsed.data;
  const provider = await providerRow(tenantId);
  if (setting.lightEnabled && (!tuyaConfig(provider) || !provider?.tuya_device_id || provider.tuya_connection_status !== "connected")) { res.status(409).json({ error: "Order light service is not configured for this tenant" }); return; }
  if (setting.smsEnabled && (!smsConfig(provider) || provider?.sms_connection_status !== "connected")) { res.status(409).json({ error: "Order SMS provider is not configured" }); return; }
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
  res.json({ settings: setting, lightConfigured: !!tuyaConfig(provider) && !!provider?.tuya_device_id && provider?.tuya_connection_status === "connected", smsConfigured: !!smsConfig(provider) && provider?.sms_connection_status === "connected", deviceAlias: "MyOrder.fun" });
});

router.put("/admin/order-notifications/providers/sms", admin, async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!; const parsed = SmsSettingsBody.safeParse(req.body ?? {});
  if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) { res.status(400).json({ error: "Invalid SMS provider settings" }); return; }
  if (!hasConfiguredSettingsEncryptionKey()) { res.status(503).json({ error: "Encrypted tenant credential storage is unavailable" }); return; }
  await ensureRow(tenantId);
  const priorRow = await providerRow(tenantId); const prior = safeJson(priorRow?.sms_credentials_ciphertext ?? null);
  const next = { accountSid: parsed.data.accountSid ?? prior?.accountSid, authToken: parsed.data.authToken ?? prior?.authToken };
  const sender = parsed.data.sender ?? priorRow?.sms_sender;
  if (!next.accountSid || !/^AC[a-f0-9]{32}$/i.test(next.accountSid) || !next.authToken || !sender) { res.status(400).json({ error: "Complete Twilio account credentials and sender configuration are required" }); return; }
  await db.transaction(async tx => {
    await tx.execute(sql`UPDATE order_notification_settings SET sms_provider='twilio',sms_sender=${sender},sms_credentials_ciphertext=${encrypt(JSON.stringify(next))},sms_connection_status='not_configured',sms_enabled=false,updated_at=now() WHERE tenant_id=${tenantId}`);
    await tx.insert(auditLogsTable).values({ tenantId, actorId: req.dbUser!.id, actorEmail: req.dbUser!.email ?? "", actorRole: req.dbUser!.role,
      action: "order_notifications.sms_credentials_updated", resourceType: "order_notification_settings", resourceId: String(tenantId),
      metadata: { provider: "twilio", accountSidUpdated: Boolean(parsed.data.accountSid), authTokenUpdated: Boolean(parsed.data.authToken), senderUpdated: Boolean(parsed.data.sender) }, ipAddress: req.ip });
  });
  res.json({ provider: "twilio", configured: true, connection: "not_configured", accountSidMasked: mask(next.accountSid), sender: mask(sender) });
});

router.post("/admin/order-notifications/providers/sms/test-connection", admin, providerTestLimiter, async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!; const config = smsConfig(await providerRow(tenantId));
  if (!config) { res.status(409).json({ connection: "not_configured" }); return; }
  try {
    await testTwilioConnection(config);
    await db.execute(sql`UPDATE order_notification_settings SET sms_connection_status='connected',sms_last_test_at=now(),updated_at=now() WHERE tenant_id=${tenantId}`);
    await writeAuditLog({ actorId: req.dbUser!.id, actorEmail: req.dbUser!.email, actorRole: req.dbUser!.role, tenantId, action: "order_notifications.sms_connection_tested", resourceType: "order_notification_settings", resourceId: String(tenantId), metadata: { provider: "twilio", connected: true }, ipAddress: req.ip });
    res.json({ connection: "connected" });
  } catch {
    await db.execute(sql`UPDATE order_notification_settings SET sms_connection_status='failed',sms_last_test_at=now(),updated_at=now() WHERE tenant_id=${tenantId}`);
    res.status(502).json({ connection: "failed", error: "The SMS provider could not authenticate this configuration" });
  }
});

router.post("/admin/order-notifications/providers/sms/test-message", admin, testMessageLimiter, async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!; const parsed = TestSmsBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Enter a valid test phone number in international format" }); return; }
  const config = smsConfig(await providerRow(tenantId)); if (!config) { res.status(409).json({ error: "SMS provider is not configured" }); return; }
  try {
    const providerReference = await sendTwilioSms(config, parsed.data.to, "MyOrder.fun SMS test. Order alert delivery is configured.");
    await db.execute(sql`UPDATE order_notification_settings SET sms_connection_status='connected',sms_last_test_at=now(),updated_at=now() WHERE tenant_id=${tenantId}`);
    await writeAuditLog({ actorId: req.dbUser!.id, actorEmail: req.dbUser!.email, actorRole: req.dbUser!.role, tenantId, action: "order_notifications.sms_test_sent", resourceType: "order_notification_settings", resourceId: String(tenantId), metadata: { provider: "twilio", destinationSuffix: parsed.data.to.slice(-4), delivered: true }, ipAddress: req.ip });
    res.json({ delivered: true, providerReference });
  } catch { await db.execute(sql`UPDATE order_notification_settings SET sms_connection_status='failed',updated_at=now() WHERE tenant_id=${tenantId}`); res.status(502).json({ delivered: false, error: "The SMS provider could not deliver the test message" }); }
});

router.put("/admin/order-notifications/providers/tuya", admin, async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!; const parsed = TuyaSettingsBody.safeParse(req.body ?? {});
  if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) { res.status(400).json({ error: "Invalid Tuya provider settings" }); return; }
  if (!hasConfiguredSettingsEncryptionKey()) { res.status(503).json({ error: "Encrypted tenant credential storage is unavailable" }); return; }
  await ensureRow(tenantId);
  const priorRow = await providerRow(tenantId); const prior = safeJson(priorRow?.tuya_credentials_ciphertext ?? null);
  const next = { clientId: parsed.data.clientId ?? prior?.clientId, clientSecret: parsed.data.clientSecret ?? prior?.clientSecret };
  const region = parsed.data.region ?? priorRow?.tuya_region;
  const deviceId = parsed.data.deviceId === undefined ? priorRow?.tuya_device_id : parsed.data.deviceId;
  const switchCode = parsed.data.switchCode ?? priorRow?.tuya_switch_code ?? "switch_1";
  if (!next.clientId || !next.clientSecret || !region || !["us","eu","in","cn","ueaz","weaz"].includes(region)) { res.status(400).json({ error: "Complete Tuya credentials and cloud region are required" }); return; }
  await db.transaction(async tx => {
    await tx.execute(sql`UPDATE order_notification_settings SET tuya_region=${region},tuya_device_id=${deviceId ?? null},tuya_switch_code=${switchCode},tuya_credentials_ciphertext=${encrypt(JSON.stringify(next))},tuya_connection_status='not_configured',light_enabled=false,updated_at=now() WHERE tenant_id=${tenantId}`);
    await tx.insert(auditLogsTable).values({ tenantId, actorId: req.dbUser!.id, actorEmail: req.dbUser!.email ?? "", actorRole: req.dbUser!.role,
      action: "order_notifications.tuya_credentials_updated", resourceType: "order_notification_settings", resourceId: String(tenantId),
      metadata: { clientIdUpdated: Boolean(parsed.data.clientId), clientSecretUpdated: Boolean(parsed.data.clientSecret), regionUpdated: Boolean(parsed.data.region), deviceUpdated: parsed.data.deviceId !== undefined }, ipAddress: req.ip });
  });
  res.json({ configured: true, connection: "not_configured", clientIdMasked: mask(next.clientId), region, deviceId, switchCode });
});

router.post("/admin/order-notifications/providers/tuya/test-connection", admin, providerTestLimiter, async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!; const row = await providerRow(tenantId); const config = tuyaConfig(row);
  if (!config) { res.status(409).json({ connection: "not_configured" }); return; }
  try {
    await getTuyaAccessToken(config);
    const devices = await listTuyaDevices(config);
    await db.execute(sql`UPDATE order_notification_settings SET tuya_connection_status='connected',tuya_last_test_at=now(),updated_at=now() WHERE tenant_id=${tenantId}`);
    await writeAuditLog({ actorId: req.dbUser!.id, actorEmail: req.dbUser!.email, actorRole: req.dbUser!.role, tenantId, action: "order_notifications.tuya_connection_tested", resourceType: "order_notification_settings", resourceId: String(tenantId), metadata: { connected: true, deviceCount: devices.length }, ipAddress: req.ip });
    res.json({ connection: "connected", deviceCount: devices.length });
  } catch { await db.execute(sql`UPDATE order_notification_settings SET tuya_connection_status='failed',tuya_last_test_at=now(),updated_at=now() WHERE tenant_id=${tenantId}`); res.status(502).json({ connection: "failed", error: "Tuya authentication or device discovery failed" }); }
});

router.get("/admin/order-notifications/providers/tuya/devices", admin, providerTestLimiter, async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!; const config = tuyaConfig(await providerRow(tenantId));
  if (!config) { res.status(409).json({ error: "Save Tuya credentials and region first" }); return; }
  try { res.json({ devices: await listTuyaDevices(config) }); }
  catch { res.status(502).json({ error: "Could not discover Tuya devices" }); }
});

router.post("/admin/order-notifications/providers/tuya/test-light", admin, providerTestLimiter, async (req, res): Promise<void> => {
  const tenantId = req.authorizedTenantId!; const row = await providerRow(tenantId); const config = tuyaConfig(row);
  if (!config || !row?.tuya_device_id) { res.status(409).json({ error: "Save Tuya credentials and select a device first" }); return; }
  try {
    await setTuyaDeviceSwitch(config, row.tuya_device_id, row.tuya_switch_code || "switch_1", true);
    try { await new Promise(resolve => setTimeout(resolve, 800)); }
    finally { await setTuyaDeviceSwitch(config, row.tuya_device_id, row.tuya_switch_code || "switch_1", false); }
    await db.execute(sql`UPDATE order_notification_settings SET tuya_connection_status='connected',tuya_last_test_at=now(),updated_at=now() WHERE tenant_id=${tenantId}`);
    await writeAuditLog({ actorId: req.dbUser!.id, actorEmail: req.dbUser!.email, actorRole: req.dbUser!.role, tenantId, action: "order_notifications.tuya_test_light", resourceType: "order_notification_settings", resourceId: String(tenantId), metadata: { deviceSelected: true, tested: true }, ipAddress: req.ip });
    res.json({ tested: true, connection: "connected" });
  } catch { await db.execute(sql`UPDATE order_notification_settings SET tuya_connection_status='failed',updated_at=now() WHERE tenant_id=${tenantId}`); res.status(502).json({ tested: false, error: "Tuya could not control the selected light" }); }
});

export default router;
