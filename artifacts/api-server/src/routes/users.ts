import { Router, type IRouter } from "express";
import { and, eq, ne } from "drizzle-orm";
import { db, usersTable, notificationsTable } from "@workspace/db";
import {
  GetCurrentUserResponse,
  ListUsersQueryParams,
  ListUsersResponse,
  UpdateUserRoleParams,
  UpdateUserRoleBody,
  UpdateUserRoleResponse,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireRole, requireDbUser, requireApproved, writeAuditLog } from "../lib/auth";
import { sendSms, smsAccountApproved } from "../lib/sms";
import { logger } from "../lib/logger";
import { z } from "zod/v4";
import { clerkClient } from "@clerk/express";
import { syncUserToClerk } from "../lib/clerkSync";

const router: IRouter = Router();

const VALID_ROLES = [
  "admin",
  "supervisor",
  "business_sitter",
  "customer_service_rep",
  "sales_rep",
  "lab_tech",
  "user",
] as const;
type ValidRole = typeof VALID_ROLES[number];

function normalizeRole(role: unknown): ValidRole {
  if (typeof role === "string" && (VALID_ROLES as readonly string[]).includes(role)) {
    return role as ValidRole;
  }
  logger.warn({ rawRole: role }, "Invalid role value in DB — defaulting to 'user'");
  return "user";
}

router.use(requireAuth, loadDbUser, requireDbUser);

// Approval gate with explicit exemptions:
//  - /users/me        — frontend reads status to decide which screen to show
//  - /users/sync      — frontend calls this on load BEFORE it knows the status
//  - /users/me/*      — e.g. /users/me/phone so pending users can add contact info
// All other /users/* routes (list, role change, status change) require approval.
router.use((req, res, next) => {
  if (
    req.path === "/users/me" ||
    req.path === "/users/sync" ||
    req.path.startsWith("/users/me/")
  ) {
    return next();
  }
  return requireApproved(req, res, next);
});

function serializeCurrentUser(user: typeof usersTable.$inferSelect) {
  return GetCurrentUserResponse.parse({
    id: user.id,
    clerkId: user.clerkId,
    email: user.email ?? undefined,
    firstName: user.firstName ?? undefined,
    lastName: user.lastName ?? undefined,
    contactPhone: user.contactPhone ?? undefined,
    avatarUrl: user.avatarUrl ?? undefined,
    role: normalizeRole(user.role),
    mfaEnabled: user.mfaEnabled ?? undefined,
    isActive: user.isActive,
    status: (user.status as "pending" | "approved" | "rejected") ?? "pending",
    createdAt: user.createdAt,
  });
}

// GET /api/users/me
router.get("/users/me", async (req, res): Promise<void> => {
  res.json(serializeCurrentUser(req.dbUser!));
});

// PATCH /api/users/me — current user updates their own editable profile fields
const UpdateMeBody = z.object({
  firstName: z.string().trim().max(100).nullish(),
  lastName: z.string().trim().max(100).nullish(),
  contactPhone: z
    .string()
    .trim()
    .max(32)
    .regex(/^(\+?[0-9 ()\-.]{7,32})?$/, "Invalid phone number")
    .nullish(),
  avatarUrl: z
    .string()
    .trim()
    .max(2048)
    .url("Avatar must be a valid URL")
    .nullish()
    .or(z.literal("")),
});

router.patch("/users/me", async (req, res): Promise<void> => {
  const user = req.dbUser!;
  const parsed = UpdateMeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const patch: Record<string, unknown> = {};
  if (parsed.data.firstName !== undefined)
    patch.firstName = parsed.data.firstName?.trim() || null;
  if (parsed.data.lastName !== undefined)
    patch.lastName = parsed.data.lastName?.trim() || null;
  if (parsed.data.contactPhone !== undefined)
    patch.contactPhone = parsed.data.contactPhone?.trim() || null;
  if (parsed.data.avatarUrl !== undefined)
    patch.avatarUrl = (parsed.data.avatarUrl ?? "").trim() || null;

  if (Object.keys(patch).length === 0) {
    res.json(serializeCurrentUser(user));
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set(patch)
    .where(eq(usersTable.id, user.id))
    .returning();

  // Mirror display name to Clerk so other surfaces (Clerk-hosted account
  // page, OAuth screens) reflect the change. Failures are logged but not
  // surfaced to the user — DB is the source of truth.
  const clerkPatch: { firstName?: string; lastName?: string } = {};
  if ("firstName" in patch) clerkPatch.firstName = (patch.firstName as string | null) ?? "";
  if ("lastName" in patch) clerkPatch.lastName = (patch.lastName as string | null) ?? "";
  if (Object.keys(clerkPatch).length > 0 && updated.clerkId && !updated.clerkId.startsWith("pending_invite:")) {
    try {
      await clerkClient.users.updateUser(updated.clerkId, clerkPatch);
    } catch (err) {
      logger.error({ err, clerkId: updated.clerkId }, "Failed to mirror name to Clerk");
    }
  }

  await writeAuditLog({
    actorId: user.id,
    actorEmail: user.email,
    actorRole: normalizeRole(user.role),
    action: "UPDATE_OWN_PROFILE",
    tenantId: user.tenantId,
    resourceType: "user",
    resourceId: String(user.id),
    metadata: { fields: Object.keys(patch) },
  });

  res.json(serializeCurrentUser(updated));
});

// POST /api/users/sync — called after Clerk sign-in to ensure user record exists
router.post("/users/sync", async (req, res): Promise<void> => {
  const user = req.dbUser!;
  const data = GetCurrentUserResponse.parse({
    id: user.id,
    clerkId: user.clerkId,
    email: user.email ?? undefined,
    firstName: user.firstName ?? undefined,
    lastName: user.lastName ?? undefined,
    contactPhone: user.contactPhone ?? undefined,
    role: normalizeRole(user.role),
    mfaEnabled: user.mfaEnabled ?? undefined,
    isActive: user.isActive,
    status: (user.status as "pending" | "approved" | "rejected") ?? "pending",
    createdAt: user.createdAt,
  });
  res.json(data);
});

// GET /api/users — admin and supervisor see all users
router.get("/users", requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const query = ListUsersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  let rows = await db.select().from(usersTable).orderBy(usersTable.createdAt);

  if (query.data.role) {
    // Compare against the normalized role so legacy values still match
    rows = rows.filter(u => normalizeRole(u.role) === query.data.role);
  }

  // Normalize each row's role before Zod validation — a single user with a
  // legacy role value (e.g. "customer") would otherwise throw and return an
  // empty list to the client with no visible error.
  const normalized = rows.map(u => ({ ...u, role: normalizeRole(u.role) }));

  const data = ListUsersResponse.parse({ users: normalized, total: normalized.length });
  res.json(data);
});

// PATCH /api/users/me/phone — user updates their own contact phone number
router.patch("/users/me/phone", async (req, res): Promise<void> => {
  const user = req.dbUser!;
  const { contactPhone } = req.body as { contactPhone?: string };
  const phone = contactPhone?.trim() || null;
  const [updated] = await db
    .update(usersTable)
    .set({ contactPhone: phone })
    .where(eq(usersTable.id, user.id))
    .returning();
  res.json({ contactPhone: updated.contactPhone ?? null });
});

// PATCH /api/users/:id/role — supervisors and admins (legacy path)
// PATCH /api/admin/users/:id/role — admin-only namespace
router.patch("/admin/users/:id/role", requireRole("admin"), updateUserRoleHandler);
router.patch("/users/:id/role", requireRole("admin", "supervisor"), updateUserRoleHandler);

async function updateUserRoleHandler(req: import("express").Request, res: import("express").Response): Promise<void> {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateUserRoleParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateUserRoleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, params.data.id)).limit(1);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [updated] = await db.update(usersTable)
    .set({ role: body.data.role })
    .where(eq(usersTable.id, params.data.id))
    .returning();

  // Mirror role into Clerk publicMetadata so subsequent sign-ins agree.
  await syncUserToClerk(updated.clerkId, { role: body.data.role });

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "UPDATE_USER_ROLE",
    resourceType: "user",
    resourceId: String(params.data.id),
    metadata: { newRole: body.data.role, previousRole: target.role },
    ipAddress: req.ip,
  });

  const data = UpdateUserRoleResponse.parse({
    id: updated.id,
    clerkId: updated.clerkId,
    email: updated.email ?? undefined,
    firstName: updated.firstName ?? undefined,
    lastName: updated.lastName ?? undefined,
    role: updated.role,
    mfaEnabled: updated.mfaEnabled,
    isActive: updated.isActive,
    createdAt: updated.createdAt,
  });
  res.json(data);
}

const UpdateUserStatusBody = z.object({
  status: z.enum(["pending", "approved", "rejected", "deactivated"]),
});

// PATCH /api/users/:id/status — admin only (alias also exposed at /api/admin/users/:id/status)
router.patch(["/users/:id/status", "/admin/users/:id/status"], requireRole("admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const body = UpdateUserStatusBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const previousStatus = target.status;
  const newStatus = body.data.status;

  const [updated] = await db
    .update(usersTable)
    .set({ status: newStatus })
    .where(eq(usersTable.id, id))
    .returning();

  // Mirror status into Clerk publicMetadata so subsequent sign-ins agree.
  await syncUserToClerk(updated.clerkId, { status: newStatus });

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "UPDATE_USER_STATUS",
    resourceType: "user",
    resourceId: String(id),
    metadata: { newStatus, previousStatus },
    ipAddress: req.ip,
  });

  if (newStatus === "approved" && previousStatus !== "approved") {
    const message = smsAccountApproved(updated.firstName);

    // Fire SMS (graceful no-op if phone missing or Twilio unconfigured)
    sendSms(updated.contactPhone, message).catch((err) => {
      logger.error({ err, userId: updated.id }, "Failed to send account approval SMS");
    });

    // Write in-app notification (non-critical — don't fail the response)
    try {
      await db.insert(notificationsTable).values({
        userId: updated.id,
        type: "account_approved",
        title: "Account Approved",
        message: "Your account has been approved. You can now sign in and start placing orders.",
        isRead: false,
        resourceType: "user",
        resourceId: updated.id,
      });
    } catch (err) {
      logger.error({ err, userId: updated.id }, "Failed to write account approval notification");
    }
  }

  res.json({
    id: updated.id,
    status: updated.status,
  });
});

// ─── GET /api/admin/users/pending — list app users with status='pending' ────
router.get("/admin/users/pending", requireRole("admin"), async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.status, "pending"))
    .orderBy(usersTable.createdAt);
  res.json({
    users: rows.map((u) => ({
      id: u.id,
      clerkId: u.clerkId,
      email: u.email ?? undefined,
      firstName: u.firstName ?? undefined,
      lastName: u.lastName ?? undefined,
      contactPhone: u.contactPhone ?? null,
      role: normalizeRole(u.role),
      status: u.status,
      mfaEnabled: u.mfaEnabled,
      isActive: u.isActive,
      createdAt: u.createdAt,
    })),
    total: rows.length,
  });
});

const ApprovalBody = z.object({
  approve: z.boolean(),
  role: z.enum([...VALID_ROLES]).optional(),
});

// ─── PATCH /api/admin/users/:id/approval — single approval flow ─────────────
// approve=true sets status='approved' (+ optional role) and pushes to Clerk.
// approve=false sets status='rejected' and pushes to Clerk.
router.patch("/admin/users/:id/approval", requireRole("admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const body = ApprovalBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const newStatus: "approved" | "rejected" = body.data.approve ? "approved" : "rejected";
  const newRole = body.data.approve && body.data.role ? body.data.role : undefined;

  const updateSet: Partial<typeof usersTable.$inferInsert> = { status: newStatus };
  if (newRole) updateSet.role = newRole;

  const [updated] = await db
    .update(usersTable)
    .set(updateSet)
    .where(eq(usersTable.id, id))
    .returning();

  // Push to Clerk publicMetadata so the next sign-in does not re-pend the user.
  await syncUserToClerk(updated.clerkId, {
    status: newStatus,
    role: newRole ?? normalizeRole(updated.role),
  });

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: body.data.approve ? "APPROVE_USER" : "REJECT_USER",
    resourceType: "user",
    resourceId: String(id),
    metadata: { newStatus, newRole, previousStatus: target.status, previousRole: target.role },
    ipAddress: req.ip,
  });

  if (newStatus === "approved" && target.status !== "approved") {
    sendSms(updated.contactPhone, smsAccountApproved(updated.firstName)).catch((err) => {
      logger.error({ err, userId: updated.id }, "Failed to send account approval SMS");
    });
    try {
      await db.insert(notificationsTable).values({
        userId: updated.id,
        type: "account_approved",
        title: "Account Approved",
        message: "Your account has been approved. You can now sign in and start placing orders.",
        isRead: false,
        resourceType: "user",
        resourceId: updated.id,
      });
    } catch (err) {
      logger.error({ err, userId: updated.id }, "Failed to write account approval notification");
    }
  }

  res.json({
    id: updated.id,
    status: updated.status,
    role: normalizeRole(updated.role),
  });
});

// ─── GET /api/admin/users/waitlist — list Clerk waitlist entries ─────────────
router.get("/admin/users/waitlist", requireRole("admin"), async (req, res): Promise<void> => {
  const query = (req.query.q as string | undefined)?.trim() || undefined;
  try {
    const result = await clerkClient.waitlistEntries.list({
      limit: 100,
      query,
    });
    res.json({
      entries: result.data.map(e => ({
        id: e.id,
        emailAddress: e.emailAddress,
        createdAt: e.createdAt,
        status: e.status,
      })),
      total: result.totalCount,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to list Clerk waitlist entries");
    res.status(500).json({ error: "Failed to fetch waitlist from Clerk" });
  }
});

const WaitlistInviteBody = z.object({
  role: z.enum([...VALID_ROLES]).default("user"),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
});

// Sentinel clerk_id used while a waitlist invite is outstanding (the real
// Clerk user does not yet exist). The webhook for `user.created` upgrades
// this row by matching on email and replacing the sentinel with the real id.
function pendingInviteSentinel(waitlistEntryId: string): string {
  return `pending_invite:${waitlistEntryId}`;
}

// ─── POST /api/admin/users/waitlist/:id/invite ────────────────────────────────
// Body: { role, firstName?, lastName? }
// Fully approves the user at invite time:
//   1. Send Clerk waitlist invite (so they get the sign-up email).
//   2. Pre-create a `users` row with status='approved' and the picked role,
//      using a sentinel clerkId tied to the waitlist entry. The webhook for
//      `user.created` will swap the sentinel for the real Clerk id once the
//      person actually accepts the invite and signs up.
router.post("/admin/users/waitlist/:id/invite", requireRole("admin"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const id = String(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Missing waitlist entry id" }); return; }

  const body = WaitlistInviteBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const { role, firstName, lastName } = body.data;

  let entry: { id: string; status: string; emailAddress: string };
  try {
    // The Clerk SDK does not expose getById for waitlist entries; the invite
    // call returns the canonical entry shape (and is idempotent thanks to
    // ignoreExisting), so a single call is enough to get the email + status.
    const invited = await clerkClient.waitlistEntries.invite(id, { ignoreExisting: true });
    entry = {
      id: invited.id,
      status: invited.status,
      emailAddress: invited.emailAddress,
    };
  } catch (err) {
    req.log.error({ err, waitlistId: id }, "Failed to invite waitlist entry");
    res.status(500).json({ error: "Failed to invite user from waitlist" });
    return;
  }

  const sentinelClerkId = pendingInviteSentinel(entry.id);
  const email = entry.emailAddress;

  // Reconcile against any existing real (non-sentinel) user row for this
  // email. If one exists, the person already has a Clerk account — skip the
  // sentinel and just promote that row to approved + the picked role. This
  // prevents stale orphan sentinel rows that would never be upgraded
  // (because no future `user.created` webhook will fire).
  let existingReal: typeof usersTable.$inferSelect | undefined;
  if (email) {
    const realRows = await db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.email, email),
          ne(usersTable.clerkId, sentinelClerkId),
        ),
      );
    existingReal = realRows.find((r) => !r.clerkId.startsWith("pending_invite:"));
  }

  let userRowCreated = false;
  let promotedExisting = false;
  try {
    if (existingReal) {
      await db
        .update(usersTable)
        .set({
          role,
          status: "approved",
          firstName: firstName ?? existingReal.firstName ?? undefined,
          lastName: lastName ?? existingReal.lastName ?? undefined,
          updatedAt: new Date(),
        })
        .where(eq(usersTable.id, existingReal.id))
        .returning();
      promotedExisting = true;
      // Also push the new state into Clerk so the existing account reflects
      // the admin's decision immediately on next sign-in.
      if (!existingReal.clerkId.startsWith("pending_invite:")) {
        await syncUserToClerk(existingReal.clerkId, { status: "approved", role });
      }
    } else {
      await db
        .insert(usersTable)
        .values({
          clerkId: sentinelClerkId,
          email,
          firstName: firstName ?? undefined,
          lastName: lastName ?? undefined,
          role,
          status: "approved",
        })
        .onConflictDoUpdate({
          target: usersTable.clerkId,
          set: {
            email,
            firstName: firstName ?? undefined,
            lastName: lastName ?? undefined,
            role,
            status: "approved",
            updatedAt: new Date(),
          },
        });
      userRowCreated = true;
    }
  } catch (err) {
    req.log.error({ err, waitlistId: id }, "Failed to pre-create users row for waitlist invite");
    res.status(500).json({ error: "Invite sent but failed to create user record" });
    return;
  }

  await writeAuditLog({
    actorId: actor.id,
    actorEmail: actor.email,
    actorRole: actor.role,
    action: "INVITE_WAITLIST_USER",
    resourceType: "user",
    resourceId: sentinelClerkId,
    metadata: { waitlistEntryId: entry.id, email, role, firstName, lastName },
    ipAddress: req.ip,
  });

  res.json({
    id: entry.id,
    status: entry.status,
    email,
    role,
    userRowCreated,
    promotedExisting,
  });
});

// ─── POST /api/admin/users/waitlist/:id/reject ────────────────────────────────
router.post("/admin/users/waitlist/:id/reject", requireRole("admin"), async (req, res): Promise<void> => {
  const id = String(req.params.id ?? "");
  if (!id) { res.status(400).json({ error: "Missing waitlist entry id" }); return; }
  try {
    const entry = await clerkClient.waitlistEntries.reject(id);
    res.json({ id: entry.id, status: entry.status });
  } catch (err) {
    req.log.error({ err }, "Failed to reject waitlist entry");
    res.status(500).json({ error: "Failed to reject waitlist entry" });
  }
});

export default router;
