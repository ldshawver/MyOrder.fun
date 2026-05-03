import { Router, type IRouter } from "express";
import { Webhook } from "svix";
import { db, usersTable } from "@workspace/db";
import { and, desc, eq, like } from "drizzle-orm";
import { logger } from "../lib/logger";
import { syncUserToClerk } from "../lib/clerkSync";

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
        // If an admin already invited this person from the Clerk waitlist
        // (which pre-creates a row with a `pending_invite:<id>` sentinel
        // clerkId, status='approved' and the picked role), upgrade that row
        // by linking the real Clerk id and preserving role/status.
        let upgraded = false;
        if (email) {
          // Look up *only* sentinel rows for this email (clerk_id starts with
          // "pending_invite:"), newest first. This avoids ambiguity when the
          // same email already has a real user row alongside a fresh invite —
          // without this filter the unrelated row could be returned first and
          // the sentinel would be silently skipped, leaving the invitee in
          // pending state.
          const [pendingInvite] = await db
            .select()
            .from(usersTable)
            .where(
              and(
                eq(usersTable.email, email),
                like(usersTable.clerkId, "pending_invite:%"),
              ),
            )
            .orderBy(desc(usersTable.createdAt))
            .limit(1);

          if (pendingInvite) {
            await db
              .update(usersTable)
              .set({
                clerkId,
                firstName: firstName ?? pendingInvite.firstName ?? undefined,
                lastName: lastName ?? pendingInvite.lastName ?? undefined,
                contactPhone: contactPhone ?? pendingInvite.contactPhone ?? undefined,
                updatedAt: new Date(),
              })
              .where(eq(usersTable.id, pendingInvite.id));
            upgraded = true;
            logger.info(
              { clerkId, email, previousClerkId: pendingInvite.clerkId, role: pendingInvite.role },
              "Upgraded pending-invite users row with real Clerk id"
            );
            // Push the pre-approved status + role into Clerk publicMetadata
            // so the very first sign-in skips the pending screen.
            await syncUserToClerk(clerkId, {
              status: (pendingInvite.status as "pending" | "approved" | "rejected" | "deactivated") ?? "approved",
              role: pendingInvite.role,
            });
          }
        }

        if (!upgraded) {
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
          // Push initial pending status into Clerk publicMetadata so the
          // dashboard and DB agree from minute zero. Failure is non-fatal.
          await syncUserToClerk(clerkId, { status: "pending", role: "user" });
        }
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
