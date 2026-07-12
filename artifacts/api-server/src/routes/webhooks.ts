import { Router, type IRouter } from "express";
import { Webhook } from "svix";
import { db, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { syncUserToClerk } from "../lib/clerkSync";
import { ensureProvisioningSchema, provisionVerifiedClerkUser, makeCorrelationId } from "../lib/userProvisioning";

const router: IRouter = Router();

router.post("/webhooks/clerk", async (req, res): Promise<void> => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    logger.error("CLERK_WEBHOOK_SECRET is not set");
    res.status(500).json({ error: "Webhook secret not configured" });
    return;
  }

  const svixId = req.headers["svix-id"] as string | undefined;
  const svixTimestamp = req.headers["svix-timestamp"] as string | undefined;
  const svixSignature = req.headers["svix-signature"] as string | undefined;

  if (!svixId || !svixTimestamp || !svixSignature) {
    res.status(400).json({ error: "Missing svix headers" });
    return;
  }

  let evt: { type: string; data: Record<string, unknown> };
  try {
    const wh = new Webhook(secret);
    evt = wh.verify(req.body as Buffer, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as typeof evt;
  } catch (err) {
    logger.warn({ err }, "Clerk webhook signature verification failed");
    res.status(400).json({ error: "Invalid webhook signature" });
    return;
  }

  const { type, data } = evt;
  const correlationId = makeCorrelationId("wh");
  const eventId = svixId;
  logger.info({ type, clerkId: data?.id, eventId: `${eventId.slice(0, 8)}…`, correlationId }, "Clerk webhook received");

  try {
    await ensureProvisioningSchema();
    const inserted = await db.execute(sql`INSERT INTO clerk_webhook_events (id, event_type, clerk_user_id, status) VALUES (${eventId}, ${type}, ${data?.id as string | undefined}, 'processing') ON CONFLICT (id) DO NOTHING RETURNING id`);
    const rows = Array.isArray((inserted as { rows?: unknown[] }).rows) ? (inserted as { rows: unknown[] }).rows : [];
    if (rows.length === 0) {
      res.status(200).json({ ok: true, duplicate: true, correlationId });
      return;
    }

    if (type === "user.created" || type === "user.updated" || type === "email.created" || type === "email.updated") {
      const clerkId = data.id as string;
      const result = await provisionVerifiedClerkUser({ clerkUser: data as never, source: `webhook:${type}`, correlationId, requireVerified: type !== "user.created" ? false : true });
      if (result.status === "failed") {
        await db.execute(sql`UPDATE clerk_webhook_events SET status='failed', error=${result.error ?? "failed"} WHERE id=${eventId}`);
        res.status(500).json({ error: "Provisioning failed", correlationId });
        return;
      }
      if (result.user && (type === "user.created" || type === "user.updated")) {
        await syncUserToClerk(clerkId, { status: result.user.status as never, role: result.user.role });
      }
      await db.execute(sql`UPDATE clerk_webhook_events SET status='processed', error=NULL WHERE id=${eventId}`);
    }

    if (type === "user.deleted") {
      const clerkId = data.id as string | undefined;
      if (clerkId) {
        await db.update(usersTable).set({ identityStatus: "deactivated", provisioningStatus: "identity_missing", isActive: false, updatedAt: new Date() }).where(eq(usersTable.clerkId, clerkId));
        logger.info({ clerkId, correlationId }, "User identity marked deleted via webhook");
      }
      await db.execute(sql`UPDATE clerk_webhook_events SET status='processed', error=NULL WHERE id=${eventId}`);
    }

    res.status(200).json({ ok: true, correlationId });
  } catch (err) {
    logger.error({ err, type, correlationId }, "Clerk webhook handler error");
    try { await db.execute(sql`UPDATE clerk_webhook_events SET status='failed', error='handler_error' WHERE id=${eventId}`); } catch {
      // Best-effort failure bookkeeping must not mask the original error.
    }
    res.status(500).json({ error: "Internal error processing webhook", correlationId });
  }
});

export default router;
