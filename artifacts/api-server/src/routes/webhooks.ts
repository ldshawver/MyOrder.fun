import { Router, type IRouter } from "express";
import { Webhook } from "svix";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

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
  logger.info({ type, clerkId: data?.id }, "Clerk webhook received");

  try {
    if (type === "user.created" || type === "user.updated") {
      const emailAddresses = (data.email_addresses as Array<{ id: string; email_address: string }>) ?? [];
      const primaryEmailId = data.primary_email_address_id as string | null;
      const email = emailAddresses.find((e) => e.id === primaryEmailId)?.email_address ?? null;

      const phoneNumbers = (data.phone_numbers as Array<{ id: string; phone_number: string }>) ?? [];
      const primaryPhoneId = data.primary_phone_number_id as string | null;
      const contactPhone = phoneNumbers.find((p) => p.id === primaryPhoneId)?.phone_number ?? null;

      const firstName = (data.first_name as string) || null;
      const lastName = (data.last_name as string) || null;
      const clerkId = data.id as string;

      if (type === "user.created") {
        await db
          .insert(usersTable)
          .values({
            clerkId,
            email,
            firstName: firstName ?? undefined,
            lastName: lastName ?? undefined,
            contactPhone: contactPhone ?? undefined,
            status: "pending",
          })
          .onConflictDoUpdate({
            target: usersTable.clerkId,
            set: {
              email,
              firstName: firstName ?? undefined,
              lastName: lastName ?? undefined,
              contactPhone: contactPhone ?? undefined,
              updatedAt: new Date(),
            },
          });
        logger.info({ clerkId }, "User created/upserted via webhook");
      } else {
        await db
          .update(usersTable)
          .set({
            email,
            firstName: firstName ?? undefined,
            lastName: lastName ?? undefined,
            contactPhone: contactPhone ?? undefined,
            updatedAt: new Date(),
          })
          .where(eq(usersTable.clerkId, clerkId));
        logger.info({ clerkId }, "User updated via webhook");
      }
    }

    if (type === "user.deleted") {
      const clerkId = data.id as string | undefined;
      if (clerkId) {
        await db.delete(usersTable).where(eq(usersTable.clerkId, clerkId));
        logger.info({ clerkId }, "User deleted via webhook");
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err, type }, "Clerk webhook handler error");
    res.status(500).json({ error: "Internal error processing webhook" });
  }
});

export default router;
