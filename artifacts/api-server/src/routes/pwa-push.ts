import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved } from "../lib/auth";
import { logger } from "../lib/logger";
import { pushEndpointHash } from "../lib/pwaPushSender";

const router: IRouter = Router();
export const SERVICE_WORKER_VERSION = "20260708-push-subscription-repair-v3";

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

router.post("/pwa/push/subscribe", async (req, res): Promise<void> => {
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
    logger.warn({ err, userId: actor.id, tenantId: actor.tenantId ?? null, deviceId, endpointHash, missingColumn }, "PWA push subscription registration failed safely");
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
