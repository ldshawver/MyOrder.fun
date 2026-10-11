import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved, requireRole } from "../lib/auth";
import { logger } from "../lib/logger";
import { isPwaPushConfigured, pushEndpointHash, sendPwaPushToUser } from "../lib/pwaPushSender";

const router: IRouter = Router();
export const SERVICE_WORKER_VERSION = "20260708-push-subscription-repair-v3";
const testPushLimiter = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: "Test notifications are rate limited. Try again in one minute." } });
const pushSubscriptionLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Push subscription changes are rate limited." } });

const PushSubscriptionBody = z.object({
  subscription: z.object({ endpoint: z.string().url(), expirationTime: z.number().nullable().optional(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }),
  device: z.object({ id: z.string().min(1).max(128), userAgent: z.string().max(512).optional(), platform: z.string().max(128).optional() }).optional(),
});


function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []);
}

export function missingColumnFromError(err: unknown): string | undefined {
  const message = String((err as { message?: unknown })?.message ?? "");
  const detail = String((err as { detail?: unknown })?.detail ?? "");
  const combined = `${message} ${detail}`;
  return combined.match(/column [\w."]*?([a-zA-Z_][a-zA-Z0-9_]*)["]? does not exist/i)?.[1];
}

async function rollbackFailedTransaction(): Promise<void> {
  try {
    await db.execute(sql`ROLLBACK`);
  } catch {
    // ROLLBACK may fail when the driver is not inside an explicit transaction; diagnostics still return JSON.
  }
}

let ensured = false;
async function ensurePushSubscriptionsTable(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pwa_push_subscriptions (
      id serial PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id integer REFERENCES tenants(id) ON DELETE CASCADE,
      device_id text NOT NULL,
      endpoint text NOT NULL UNIQUE,
      subscription jsonb NOT NULL,
      user_agent text,
      platform text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now(),
      last_seen_at timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS pwa_push_subscriptions_user_active_idx ON pwa_push_subscriptions (user_id, is_active)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS pwa_push_subscriptions_tenant_active_idx ON pwa_push_subscriptions (tenant_id, is_active)`);
  ensured = true;
}

router.use("/pwa/push", requireAuth, loadDbUser, requireDbUser, requireApproved);

const orderAlertRole = requireRole("global_admin", "admin", "supervisor", "csr");
const orderAlertBody = z.object({ enabled: z.boolean() }).strict();
function actorTenant(req: Request, res: Response): number | null {
  const tenantId = req.dbUser?.tenantId;
  if (!Number.isSafeInteger(tenantId) || tenantId == null || tenantId <= 0) { res.status(403).json({ error: "Tenant assignment required" }); return null; }
  return tenantId;
}

router.get("/pwa/push/order-alerts", orderAlertRole, async (req, res): Promise<void> => {
  const actor = req.dbUser!; const tenantId = actorTenant(req, res); if (tenantId == null) return;
  await ensurePushSubscriptionsTable();
  const result = await db.execute(sql`SELECT web_push_order_alerts_enabled AS enabled FROM users WHERE id=${actor.id} AND tenant_id=${tenantId}`);
  const subscription = await db.execute(sql`SELECT count(*)::int AS count FROM pwa_push_subscriptions WHERE tenant_id=${tenantId} AND user_id=${actor.id} AND is_active=true`);
  res.json({ enabled: Boolean(rowsFrom<{ enabled: boolean }>(result)[0]?.enabled), activeSubscriptionCount: Number(rowsFrom<{ count: number }>(subscription)[0]?.count ?? 0), deliveryConfigured: isPwaPushConfigured(), vapidPublicKeyConfigured: Boolean(process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY), serviceWorkerVersion: SERVICE_WORKER_VERSION });
});

router.put("/pwa/push/order-alerts", orderAlertRole, async (req, res): Promise<void> => {
  const actor = req.dbUser!; const tenantId = actorTenant(req, res); if (tenantId == null) return;
  const parsed = orderAlertBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid order alert preference" }); return; }
  await ensurePushSubscriptionsTable();
  const active = rowsFrom<{ count: number }>(await db.execute(sql`SELECT count(*)::int AS count FROM pwa_push_subscriptions WHERE tenant_id=${tenantId} AND user_id=${actor.id} AND is_active=true`))[0]?.count ?? 0;
  if (parsed.data.enabled && !isPwaPushConfigured()) { res.status(503).json({ error: "Browser push delivery is not configured on the server" }); return; }
  if (parsed.data.enabled && Number(active) === 0) { res.status(409).json({ error: "Register this browser for push notifications before enabling order alerts" }); return; }
  await db.transaction(async tx => {
    await tx.execute(sql`UPDATE users SET web_push_order_alerts_enabled=${parsed.data.enabled},updated_at=now() WHERE id=${actor.id} AND tenant_id=${tenantId}`);
    if (!parsed.data.enabled) {
      await tx.execute(sql`UPDATE pwa_push_subscriptions SET is_active=false,updated_at=now() WHERE user_id=${actor.id} AND tenant_id=${tenantId}`);
      await tx.execute(sql`UPDATE order_push_notification_jobs SET state='skipped',failure_class='recipient_disabled',completed_at=now(),lease_until=NULL,updated_at=now()
        WHERE tenant_id=${tenantId} AND recipient_user_id=${actor.id} AND state='queued'`);
    }
  });
  res.json({ enabled: parsed.data.enabled, activeSubscriptionCount: parsed.data.enabled ? Number(active) : 0 });
});

router.post("/pwa/push/order-alerts/test", orderAlertRole, testPushLimiter, async (req, res): Promise<void> => {
  const actor = req.dbUser!; const tenantId = actorTenant(req, res); if (tenantId == null) return;
  const pref = rowsFrom<{ enabled: boolean }>(await db.execute(sql`SELECT web_push_order_alerts_enabled AS enabled FROM users WHERE id=${actor.id} AND tenant_id=${tenantId}`))[0];
  if (!pref?.enabled) { res.status(409).json({ error: "Enable order alerts before sending a test" }); return; }
  if (!isPwaPushConfigured()) { res.status(503).json({ error: "Browser push delivery is not configured on the server" }); return; }
  const result = await sendPwaPushToUser({ tenantId, userId: actor.id, payload: { type: "order", title: "MyOrder test alert", body: "Browser order alerts are enabled for this account.", url: "/admin/order-notifications", tag: `myorder-test-${actor.id}` } });
  if (result.skipped || result.attempted === 0) { res.status(409).json({ error: "No active push subscription is available for this browser" }); return; }
  if (result.sent === 0) { res.status(502).json({ error: "The push service could not deliver the test notification" }); return; }
  res.json({ ok: true, sent: result.sent, failed: result.failed });
});

router.get("/pwa/push/debug", async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  try {
    await ensurePushSubscriptionsTable();
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::int AS active_subscription_count,
        MAX(device_id) AS latest_device_id,
        MAX(updated_at) AS latest_subscription_seen_at
      FROM pwa_push_subscriptions
      WHERE user_id = ${actor.id} AND is_active = true
    `);
    const row = rowsFrom<{ active_subscription_count?: number | string; latest_device_id?: string | null; latest_subscription_seen_at?: string | Date | null }>(result)[0];
    const count = Number(row?.active_subscription_count ?? 0);
    res.status(200).json({
      ok: true,
      success: true,
      reason: count > 0 ? "active_push_subscription_found" : "no_active_push_subscription",
      notificationPermission: req.query.permission ?? "unknown",
      active_subscription: count > 0,
      pushSubscriptionActive: count > 0,
      activeSubscriptionCount: count,
      serviceWorkerVersion: SERVICE_WORKER_VERSION,
      vapidPublicKeyConfigured: Boolean(process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY),
      diagnostics: {
        user: { id: actor.id },
        company: { id: actor.tenantId ?? null },
        device: { latestDeviceId: row?.latest_device_id ?? null },
        subscription: { active: count > 0, activeCount: count, latestSeenAt: row?.latest_subscription_seen_at ?? null },
      },
    });
  } catch (err) {
    await rollbackFailedTransaction();
    const missingColumn = missingColumnFromError(err);
    logger.warn({ err, userId: actor.id, tenantId: actor.tenantId ?? null, missingColumn }, "PWA push debug degraded but returned 200");
    res.status(200).json({
      ok: false,
      success: false,
      database_schema_error: Boolean(missingColumn),
      missing_column: missingColumn,
      reason: missingColumn ? "database_schema_mismatch" : "push_diagnostics_degraded",
      notificationPermission: req.query.permission ?? "unknown",
      active_subscription: false,
      pushSubscriptionActive: false,
      activeSubscriptionCount: 0,
      serviceWorkerVersion: SERVICE_WORKER_VERSION,
      error: "Push diagnostics hit a database schema issue; repair can still be attempted after the schema is corrected.",
      diagnostics: {
        user: { id: actor.id },
        company: { id: actor.tenantId ?? null },
        device: { latestDeviceId: null },
        subscription: { active: false, activeCount: 0, latestSeenAt: null },
      },
    });
  }
});

router.get("/pwa/push/vapid-public-key", (_req, res): void => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY || "" });
});

router.post("/pwa/push/subscribe", pushSubscriptionLimiter, async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const parsed = PushSubscriptionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid push subscription payload", details: parsed.error.flatten() });
    return;
  }
  const { subscription, device } = parsed.data;
  const deviceId = device?.id ?? `web-${actor.id}`;
  const endpointHash = pushEndpointHash(subscription.endpoint);
  try {
    await ensurePushSubscriptionsTable();
    await db.execute(sql`
    INSERT INTO pwa_push_subscriptions (user_id, tenant_id, device_id, endpoint, subscription, user_agent, platform, is_active, updated_at, last_seen_at)
    VALUES (${actor.id}, ${actor.tenantId ?? null}, ${deviceId}, ${subscription.endpoint}, ${JSON.stringify(subscription)}::jsonb, ${device?.userAgent ?? null}, ${device?.platform ?? null}, true, now(), now())
    ON CONFLICT (endpoint) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      tenant_id = EXCLUDED.tenant_id,
      device_id = EXCLUDED.device_id,
      subscription = EXCLUDED.subscription,
      user_agent = EXCLUDED.user_agent,
      platform = EXCLUDED.platform,
      is_active = true,
      updated_at = now(),
      last_seen_at = now()
  `);
  } catch (err) {
    await rollbackFailedTransaction();
    const missingColumn = missingColumnFromError(err);
    const code = typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : undefined;
    logger.warn({ userId: actor.id, tenantId: actor.tenantId ?? null, deviceId, endpointHash, missingColumn, code }, "PWA push subscription registration failed safely");
    res.status(500).json({
      ok: false,
      success: false,
      database_schema_error: Boolean(missingColumn),
      missing_column: missingColumn,
      reason: missingColumn ? "database_schema_mismatch" : "push_subscription_registration_failed",
      error: "Could not register this device for push notifications.",
    });
    return;
  }
  req.log?.info({ event: "pwa_push_subscription_registered", userId: actor.id, tenantId: actor.tenantId ?? null, deviceId, endpointHash }, "PWA push subscription registered");
  res.status(200).json({ ok: true, pushSubscriptionActive: true, userId: actor.id, tenantId: actor.tenantId ?? null, deviceId, endpointHash });
});

export default router;
