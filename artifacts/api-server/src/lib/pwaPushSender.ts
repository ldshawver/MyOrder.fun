import crypto from "node:crypto";
import webpush, { type PushSubscription } from "web-push";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

export type PwaPushPayload = {
  type: "sms" | "order" | "system";
  title: string;
  body: string;
  url?: string;
  tag?: string;
  badgeCount?: number;
  vibrate?: number[] | false;
};

type SubscriptionRow = {
  id: number;
  user_id: number;
  tenant_id: number | null;
  endpoint: string;
  subscription: PushSubscription;
};

function rowsFrom<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []);
}

export function pushEndpointHash(endpoint: string): string {
  return crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
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
  await db.execute(sql`CREATE INDEX IF NOT EXISTS pwa_push_subscriptions_tenant_active_idx ON pwa_push_subscriptions (tenant_id, is_active)`);
  ensured = true;
}

function configureWebPush(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:support@myorder.fun", publicKey, privateKey);
  return true;
}

export async function sendPwaPushToTenant(input: { tenantId: number | null; payload: PwaPushPayload }): Promise<{ attempted: number; sent: number; failed: number; skipped: boolean }> {
  if (!configureWebPush()) {
    logger.warn({ event: "pwa_push_skipped", reason: "missing_vapid_env" }, "PWA push skipped: VAPID environment is incomplete");
    return { attempted: 0, sent: 0, failed: 0, skipped: true };
  }

  await ensurePushSubscriptionsTable();

  const query = input.tenantId == null
    ? sql`SELECT id, user_id, tenant_id, endpoint, subscription FROM pwa_push_subscriptions WHERE is_active = true`
    : sql`SELECT id, user_id, tenant_id, endpoint, subscription FROM pwa_push_subscriptions WHERE is_active = true AND tenant_id = ${input.tenantId}`;
  const subscriptions = rowsFrom<SubscriptionRow>(await db.execute(query));
  let sent = 0;
  let failed = 0;
  const payload = JSON.stringify({ badge: "/lc-icon.png", ...input.payload });

  for (const row of subscriptions) {
    const endpointHash = pushEndpointHash(row.endpoint);
    try {
      await webpush.sendNotification(row.subscription, payload);
      sent += 1;
      logger.info({ event: "pwa_push_sent", subscriptionId: row.id, userId: row.user_id, tenantId: row.tenant_id, endpointHash, type: input.payload.type }, "PWA push sent");
    } catch (err) {
      failed += 1;
      const statusCode = (err as { statusCode?: number }).statusCode;
      logger.warn({ event: "pwa_push_failed", subscriptionId: row.id, userId: row.user_id, tenantId: row.tenant_id, endpointHash, statusCode, type: input.payload.type }, "PWA push failed");
      if (statusCode === 404 || statusCode === 410) {
        await db.execute(sql`UPDATE pwa_push_subscriptions SET is_active = false, updated_at = now() WHERE id = ${row.id}`);
      }
    }
  }

  return { attempted: subscriptions.length, sent, failed, skipped: false };
}
