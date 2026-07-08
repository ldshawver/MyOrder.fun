import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth, loadDbUser, requireDbUser, requireApproved } from "../lib/auth";
import { logger } from "../lib/logger";
import { pushEndpointHash } from "../lib/pwaPushSender";

const router: IRouter = Router();
const SERVICE_WORKER_VERSION = "20260708-push-subscription-repair";

const PushSubscriptionBody = z.object({
  subscription: z.object({ endpoint: z.string().url(), expirationTime: z.number().nullable().optional(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }),
  device: z.object({ id: z.string().min(1).max(128), userAgent: z.string().max(512).optional(), platform: z.string().max(128).optional() }).optional(),
});

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
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM pwa_push_subscriptions
      WHERE user_id = ${actor.id} AND is_active = true
    `);
    const count = Number((rows as unknown as { rows?: Array<{ count?: number | string }> }).rows?.[0]?.count ?? 0);
    res.status(200).json({
      ok: true,
      notificationPermission: req.query.permission ?? "unknown",
      pushSubscriptionActive: count > 0,
      activeSubscriptionCount: count,
      serviceWorkerVersion: SERVICE_WORKER_VERSION,
      vapidPublicKeyConfigured: Boolean(process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY),
    });
  } catch (err) {
    logger.warn({ err, userId: actor.id }, "PWA push debug degraded but returned 200");
    res.status(200).json({
      ok: false,
      notificationPermission: req.query.permission ?? "unknown",
      pushSubscriptionActive: false,
      activeSubscriptionCount: 0,
      serviceWorkerVersion: SERVICE_WORKER_VERSION,
      error: "Push diagnostics are temporarily degraded; repair can still be attempted.",
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
  await ensurePushSubscriptionsTable();
  const { subscription, device } = parsed.data;
  const deviceId = device?.id ?? `web-${actor.id}`;
  const endpointHash = pushEndpointHash(subscription.endpoint);
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
  req.log?.info({ event: "pwa_push_subscription_registered", userId: actor.id, tenantId: actor.tenantId ?? null, deviceId, endpointHash }, "PWA push subscription registered");
  res.status(200).json({ ok: true, pushSubscriptionActive: true, userId: actor.id, tenantId: actor.tenantId ?? null, deviceId, endpointHash });
});

export default router;
