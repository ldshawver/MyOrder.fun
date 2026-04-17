import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
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
import { z } from "zod";

const router: IRouter = Router();

const VALID_ROLES = ["admin", "supervisor", "business_sitter", "user"] as const;
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

// GET /api/users/me
router.get("/users/me", async (req, res): Promise<void> => {
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

// PATCH /api/users/:id/role
router.patch("/users/:id/role", requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
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
});

const UpdateUserStatusBody = z.object({
  status: z.enum(["pending", "approved", "rejected"]),
});

// PATCH /api/users/:id/status — admin only
router.patch("/users/:id/status", requireRole("admin"), async (req, res): Promise<void> => {
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

export default router;
