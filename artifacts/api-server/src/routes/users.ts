import { Router, type IRouter } from "express";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, usersTable, notificationsTable, onboardingRequestsTable } from "@workspace/db";
import {
  GetCurrentUserResponse,
  ListUsersQueryParams,
  ListUsersResponse,
  UpdateUserRoleParams,
  UpdateUserRoleBody,
  UpdateUserRoleResponse,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireRole, requireDbUser, requireApproved, writeAuditLog, normalizeRole as normalizeAuthRole } from "../lib/auth";
import { sendSms, smsAccountApproved } from "../lib/sms";
import { logger } from "../lib/logger";
import { z } from "zod/v4";
import { clerkClient } from "@clerk/express";
import { syncUserToClerk, syncProfileToClerk, syncAvatarToClerk } from "../lib/clerkSync";

// E.164-ish: optional leading +, then digits/spaces/dashes, total 7–20 chars.
const PHONE_REGEX = /^\+?[\d\s-]{7,20}$/;

// Unknown fields are stripped by Zod (the schema is not `.strict()`),
// so callers may send extra keys (e.g. legacy form fields) without the
// request failing — only the allowed fields below are ever persisted.
const UpdateCurrentUserBody = z.object({
  firstName: z.string().trim().max(100).nullish(),
  lastName: z.string().trim().max(100).nullish(),
  contactPhone: z
    .string()
    .trim()
    .refine((v) => v === "" || PHONE_REGEX.test(v), {
      message: "Invalid phone number — use E.164 or +? digits/spaces/dashes (7–20 chars)",
    })
    .nullish(),
  avatarUrl: z
    .string()
    .trim()
    .max(1_500_000)
    .refine((v) => v === "" || /^https?:\/\//i.test(v) || /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v), {
      message: "avatarUrl must be an http(s) URL or uploaded image",
    })
    .nullish(),
  notificationPreferences: z.object({
    orderAlerts: z.enum(["in_app", "silent", "sound", "vibrate"]).default("sound"),
    platformUpdates: z.enum(["in_app", "silent", "sound", "vibrate"]).default("in_app"),
  }).nullish(),
});

const router: IRouter = Router();
let usersListSchemaEnsured = false;

const VALID_ROLES = [
  "global_admin",
  "admin",
  "csr",
  "customer_service_rep",
  "user",
] as const;
type ValidRole = typeof VALID_ROLES[number];
type ValidStatus = "pending" | "approved" | "rejected" | "deactivated";

function normalizeRole(role: unknown): ValidRole {
  return normalizeAuthRole(role) as ValidRole;
}

function normalizeStatus(status: unknown): ValidStatus {
  if (
    status === "pending" ||
    status === "approved" ||
    status === "rejected" ||
    status === "deactivated"
  ) {
    return status;
  }
  logger.warn({ rawStatus: status }, "Invalid user status value in DB — defaulting to 'pending'");
  return "pending";
}

function hasRealClerkUserId(clerkId: string | null | undefined): clerkId is string {
  return !!clerkId && !clerkId.startsWith("pending_invite:") && !clerkId.startsWith("pending_request:");
}

async function ensureUsersListSchema(): Promise<void> {
  if (usersListSchemaEnsured) return;

  const statements = [
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_enabled" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_secret" text`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_backup_codes" text`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "first_name" text`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_name" text`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "contact_phone" text`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" text`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notification_preferences" jsonb DEFAULT '{"orderAlerts":"sound","platformUpdates":"in_app"}'::jsonb`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'pending'`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_default_tech" boolean NOT NULL DEFAULT false`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL`,
    sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL`,
  ];

  for (const statement of statements) {
    await db.execute(statement);
  }
  usersListSchemaEnsured = true;
}

function onboardingStatusToUserStatus(status: string | null | undefined): "pending" | "approved" | "rejected" {
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  return "pending";
}

async function syncOnboardingRequestsToPendingUsers(): Promise<void> {
  const requests = await db.select().from(onboardingRequestsTable);

  for (const request of requests) {
    const email = request.contactEmail?.trim();
    if (!email) continue;

    try {
      const [existing] = await db
        .select({
          id: usersTable.id,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          contactPhone: usersTable.contactPhone,
          status: usersTable.status,
        })
        .from(usersTable)
        .where(sql`lower(${usersTable.email}) = lower(${email})`)
        .limit(1);
      if (existing) {
        const updates: Partial<typeof usersTable.$inferInsert> = {};
        if (!existing.firstName && request.contactName) updates.firstName = request.contactName;
        if (!existing.contactPhone && request.contactPhone) updates.contactPhone = request.contactPhone;
        const requestStatus = onboardingStatusToUserStatus(request.status);
        if (existing.status !== "approved" && existing.status !== requestStatus) updates.status = requestStatus;
        if (Object.keys(updates).length > 0) {
          updates.updatedAt = new Date();
          await db.update(usersTable).set(updates).where(eq(usersTable.id, existing.id));
        }
        continue;
      }

      await db.insert(usersTable).values({
        clerkId: `pending_request:${email.toLowerCase()}`,
        email,
        firstName: request.contactName,
        contactPhone: request.contactPhone ?? null,
        role: "user",
        status: onboardingStatusToUserStatus(request.status),
        isActive: true,
      });
    } catch (err) {
      logger.warn({ err, requestId: request.id, email }, "Failed to mirror onboarding request into users table");
    }
  }
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

function serializeUser(user: typeof usersTable.$inferSelect) {
  return GetCurrentUserResponse.parse({
    id: user.id,
    clerkId: user.clerkId,
    email: user.email ?? undefined,
    firstName: user.firstName ?? undefined,
    lastName: user.lastName ?? undefined,
    contactPhone: user.contactPhone ?? undefined,
    avatarUrl: user.avatarUrl ?? undefined,
    notificationPreferences: user.notificationPreferences ?? { orderAlerts: "sound", platformUpdates: "in_app" },
    role: normalizeRole(user.role),
    mfaEnabled: user.mfaEnabled ?? undefined,
    isActive: user.isActive,
    status: normalizeStatus(user.status),
    createdAt: user.createdAt,
  });
}

// GET /api/users/me
router.get("/users/me", async (req, res): Promise<void> => {
  res.json(serializeUser(req.dbUser!));
});

// PATCH /api/users/me — current user updates their own profile
router.patch("/users/me", async (req, res): Promise<void> => {
  const user = req.dbUser!;
  const body = UpdateCurrentUserBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  // Build the DB update set ONLY from fields the client actually sent. This
  // ignores unknown fields (Zod .strict already rejected them above) and
  // avoids clobbering values the user did not intend to change.
  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if ("firstName" in body.data) {
    const v = body.data.firstName;
    updates.firstName = v == null || v === "" ? null : v;
  }
  if ("lastName" in body.data) {
    const v = body.data.lastName;
    updates.lastName = v == null || v === "" ? null : v;
  }
  if ("contactPhone" in body.data) {
    const v = body.data.contactPhone;
    updates.contactPhone = v == null || v === "" ? null : v;
  }
  if ("avatarUrl" in body.data) {
    const v = body.data.avatarUrl;
    updates.avatarUrl = v == null || v === "" ? null : v;
  }
  if ("notificationPreferences" in body.data && body.data.notificationPreferences) {
    updates.notificationPreferences = body.data.notificationPreferences;
  }
  if ("smsOptIn" in body.data && body.data.smsOptIn != null) {
    updates.smsOptIn = body.data.smsOptIn === true;
  }

  if (Object.keys(updates).length === 0) {
    res.json(serializeUser(user));
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, user.id))
    .returning();

  // Mirror name + phone to Clerk so the two systems agree (best-effort).
  // Skip the call entirely for the `pending_invite:*` sentinel clerkIds —
  // those rows are placeholders for waitlisted users and have no real
  // Clerk account yet.
  const hasRealClerkId = !!updated.clerkId && !updated.clerkId.startsWith("pending_invite:");
  if (
    ("firstName" in updates || "lastName" in updates || "contactPhone" in updates) &&
    hasRealClerkId
  ) {
    await syncProfileToClerk(updated.clerkId, {
      firstName: "firstName" in updates ? (updates.firstName ?? null) : undefined,
      lastName: "lastName" in updates ? (updates.lastName ?? null) : undefined,
      phoneNumber: "contactPhone" in updates ? (updates.contactPhone ?? null) : undefined,
    });
  }

  // Mirror avatar to Clerk via updateUserProfileImage when it changes.
  if ("avatarUrl" in updates && hasRealClerkId) {
    await syncAvatarToClerk(updated.clerkId, updates.avatarUrl ?? null);
  }

  await writeAuditLog({
    actorId: user.id,
    actorEmail: user.email,
    actorRole: normalizeRole(user.role),
    action: "UPDATE_OWN_PROFILE",
    tenantId: user.tenantId,
    resourceType: "user",
    resourceId: String(user.id),
    metadata: { fields: Object.keys(updates) },
  });

  res.json(serializeUser(updated));
});

// POST /api/users/sync — called after Clerk sign-in to ensure user record exists
router.post("/users/sync", async (req, res): Promise<void> => {
  res.json(serializeUser(req.dbUser!));
});

// GET /api/users — admin and supervisor see all users
router.get("/users", requireRole("global_admin", "admin"), async (req, res): Promise<void> => {
  const query = ListUsersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  await ensureUsersListSchema();
  await syncOnboardingRequestsToPendingUsers();

  let rows = await db.select().from(usersTable).orderBy(usersTable.createdAt);

  if (query.data.role) {
    // Compare against the normalized role so legacy values still match
    rows = rows.filter(u => normalizeRole(u.role) === query.data.role);
  }

  // Normalize each row before Zod validation:
  //  - role: legacy values (e.g. "customer") default to "user"
  //  - email: nullable in DB but Zod schema requires string — coerce null → ""
  //  - clerkId: shouldn't be null (DB constraint), but guard anyway
  const normalized = rows.map(u => ({
    id: u.id,
    clerkId: u.clerkId ?? "",
    email: u.email ?? "",
    firstName: u.firstName ?? undefined,
    lastName: u.lastName ?? undefined,
    role: normalizeRole(u.role),
    tenantId: u.tenantId ?? undefined,
    mfaEnabled: u.mfaEnabled ?? undefined,
    status: normalizeStatus(u.status),
    isActive: u.isActive ?? true,
    contactPhone: u.contactPhone ?? null,
    avatarUrl: u.avatarUrl ?? null,
    createdAt: u.createdAt,
  }));

  const parsed = ListUsersResponse.safeParse({ users: normalized, total: normalized.length });
  if (!parsed.success) {
    logger.error({ error: parsed.error.message }, "GET /users — response schema validation failed");
    res.status(500).json({ error: "Failed to serialize user list — contact admin", detail: parsed.error.message });
    return;
  }
  res.json(parsed.data);
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
router.patch("/users/:id/role", requireRole("global_admin", "admin"), updateUserRoleHandler);

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
  if (hasRealClerkUserId(updated.clerkId)) {
    await syncUserToClerk(updated.clerkId, { role: body.data.role });
  }

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
  if (hasRealClerkUserId(updated.clerkId)) {
    await syncUserToClerk(updated.clerkId, { status: newStatus });
  }

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
  await ensureUsersListSchema();
  await syncOnboardingRequestsToPendingUsers();

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
  if (newRole) updateSet.role = normalizeRole(newRole);

  const [updated] = await db
    .update(usersTable)
    .set(updateSet)
    .where(eq(usersTable.id, id))
    .returning();

  // Push to Clerk publicMetadata so the next sign-in does not re-pend the user.
  if (hasRealClerkUserId(updated.clerkId)) {
    await syncUserToClerk(updated.clerkId, {
      status: newStatus,
      role: normalizeRole(newRole ?? updated.role),
    });
  }

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
    await syncOnboardingRequestsToPendingUsers();
    const result = await clerkClient.waitlistEntries.list({
      limit: 100,
      query,
    });
    const emails = result.data.map(e => e.emailAddress?.trim().toLowerCase()).filter((email): email is string => !!email);
    const emailSet = new Set(emails);
    const [users, requests] = emailSet.size > 0
      ? await Promise.all([
          db.select({
            email: usersTable.email,
            firstName: usersTable.firstName,
            lastName: usersTable.lastName,
            contactPhone: usersTable.contactPhone,
          }).from(usersTable),
          db.select({
            contactEmail: onboardingRequestsTable.contactEmail,
            contactName: onboardingRequestsTable.contactName,
            contactPhone: onboardingRequestsTable.contactPhone,
          }).from(onboardingRequestsTable),
        ])
      : [[], []];
    const userByEmail = new Map(users
      .filter(user => user.email && emailSet.has(user.email.toLowerCase()))
      .map(user => [user.email?.toLowerCase(), user]));
    const requestByEmail = new Map(requests
      .filter(request => request.contactEmail && emailSet.has(request.contactEmail.toLowerCase()))
      .map(request => [request.contactEmail?.toLowerCase(), request]));
    res.json({
      entries: result.data.map(e => {
        const emailKey = e.emailAddress?.toLowerCase();
        const user = userByEmail.get(emailKey);
        const request = requestByEmail.get(emailKey);
        return {
          id: e.id,
          emailAddress: e.emailAddress,
          createdAt: e.createdAt,
          status: e.status,
          firstName: user?.firstName ?? request?.contactName ?? null,
          lastName: user?.lastName ?? null,
          contactName: request?.contactName ?? user?.firstName ?? null,
          contactPhone: user?.contactPhone ?? request?.contactPhone ?? null,
        };
      }),
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
  // Frontend passes the email it already has so we never hard-fail when
  // the Clerk waitlist API is unavailable (e.g. Restricted mode).
  email: z.string().email().optional(),
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
  const { role, email: bodyEmail } = body.data;
  let { firstName, lastName } = body.data;

  // Pre-fetch email from the waitlist list so we have it even if the Clerk
  // invite call fails (e.g. entry already processed, Clerk not in Waitlist
  // mode, or the user has already signed up via a direct invite link).
  // The frontend also sends the email it already has as a reliable fallback.
  let prefetchedEmail: string | null = bodyEmail ?? null;
  try {
    const list = await clerkClient.waitlistEntries.list({ limit: 500 });
    const found = list.data.find((e) => e.id === id);
    if (found) prefetchedEmail = found.emailAddress;
  } catch {
    // best-effort — continue even if the list call fails (bodyEmail is the fallback)
  }

  let entry: { id: string; status: string; emailAddress: string };
  let clerkInviteFailed = false;
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
    req.log.error({ err, waitlistId: id }, "Clerk waitlist invite failed — attempting DB-only approval");
    // If we have no email at all we genuinely cannot proceed
    if (!prefetchedEmail) {
      res.status(500).json({ error: "Failed to invite user from waitlist and could not determine their email. If this user has already signed up, find them in the Platform Users tab and approve them there instead." });
      return;
    }
    // Proceed without the Clerk invite — the DB row will be created/updated
    // so the user is approved. They won't receive an invite email, but if
    // they already have a Clerk account the next sign-in will pick up the
    // approved status from our DB.
    clerkInviteFailed = true;
    entry = { id, status: "clerk_invite_skipped", emailAddress: prefetchedEmail };
  }

  const sentinelClerkId = pendingInviteSentinel(entry.id);
  const email = entry.emailAddress;

  if (email && (!firstName || !lastName)) {
    try {
      const [request] = await db
        .select({
          contactName: onboardingRequestsTable.contactName,
          contactPhone: onboardingRequestsTable.contactPhone,
        })
        .from(onboardingRequestsTable)
        .where(sql`lower(${onboardingRequestsTable.contactEmail}) = lower(${email})`)
        .limit(1);
      if (request?.contactName) {
        const parts = request.contactName.trim().split(/\s+/).filter(Boolean);
        firstName = firstName || request.contactName.trim();
        lastName = lastName || (parts.length > 1 ? parts.slice(1).join(" ") : undefined);
      }
    } catch (err) {
      req.log.warn({ err, email }, "Could not enrich waitlist invite name from onboarding request");
    }
  }

  // Reconcile against any existing real (non-sentinel) user row for this
  // email. If one exists, the person already has a Clerk account — skip the
  // sentinel and just promote that row to approved + the picked role. This
  // prevents stale orphan sentinel rows that would never be upgraded
  // (because no future `user.created` webhook will fire).
  let existingReal: typeof usersTable.$inferSelect | undefined;
  if (email) {
    // Case-insensitive email match — see webhooks.ts for the rationale.
    const realRows = await db
      .select()
      .from(usersTable)
      .where(
        and(
          sql`lower(${usersTable.email}) = lower(${email})`,
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
      if (hasRealClerkUserId(existingReal.clerkId)) {
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
    clerkInviteFailed,
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
    // Clerk may not be in Waitlist mode, or the entry is already processed.
    // Either way the admin's intent is fulfilled — return success gracefully.
    req.log.warn({ err, waitlistId: id }, "Clerk waitlist reject failed — returning success anyway");
    res.json({ id, status: "rejected", clerkRejectFailed: true });
  }
});

export default router;
