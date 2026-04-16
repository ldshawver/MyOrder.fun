import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, usersTable, tenantsTable } from "@workspace/db";
import {
  GetCurrentUserResponse,
  ListUsersQueryParams,
  ListUsersResponse,
  UpdateUserRoleParams,
  UpdateUserRoleBody,
  UpdateUserRoleResponse,
} from "@workspace/api-zod";
import { requireAuth, loadDbUser, requireRole, requireDbUser, writeAuditLog } from "../lib/auth";

const router: IRouter = Router();

// Apply auth middleware
router.use(requireAuth, loadDbUser, requireDbUser);


// GET /api/users/me
router.get("/users/me", async (req, res): Promise<void> => {
  const user = req.dbUser!;
  let tenantName: string | undefined;
  if (user.tenantId) {
    const [tenant] = await db.select({ name: tenantsTable.name }).from(tenantsTable).where(eq(tenantsTable.id, user.tenantId)).limit(1);
    tenantName = tenant?.name;
  }
  const data = GetCurrentUserResponse.parse({
    id: user.id,
    clerkId: user.clerkId,
    email: user.email ?? undefined,
    firstName: user.firstName ?? undefined,
    lastName: user.lastName ?? undefined,
    contactPhone: user.contactPhone ?? undefined,
    role: user.role,
    tenantId: user.tenantId ?? undefined,
    tenantName,
    mfaEnabled: user.mfaEnabled ?? undefined,
    isActive: user.isActive,
    status: (user.status as "pending" | "approved" | "rejected") ?? "pending",
    createdAt: user.createdAt,
  });
  res.json(data);
});

// POST /api/users/sync — called after Clerk sign-in to ensure user record exists
// This is the same as GET /api/users/me but via POST so it can be called on first-sign-in
router.post("/users/sync", async (req, res): Promise<void> => {
  const user = req.dbUser!;
  let tenantName: string | undefined;
  if (user.tenantId) {
    const [tenant] = await db.select({ name: tenantsTable.name }).from(tenantsTable).where(eq(tenantsTable.id, user.tenantId)).limit(1);
    tenantName = tenant?.name;
  }
  const data = GetCurrentUserResponse.parse({
    id: user.id,
    clerkId: user.clerkId,
    email: user.email ?? undefined,
    firstName: user.firstName ?? undefined,
    lastName: user.lastName ?? undefined,
    contactPhone: user.contactPhone ?? undefined,
    role: user.role,
    tenantId: user.tenantId ?? undefined,
    tenantName,
    mfaEnabled: user.mfaEnabled ?? undefined,
    isActive: user.isActive,
    status: (user.status as "pending" | "approved" | "rejected") ?? "pending",
    createdAt: user.createdAt,
  });
  res.json(data);
});

// GET /api/users — admin sees all users; supervisor sees their tenant's users
router.get("/users", requireRole("admin", "supervisor"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const query = ListUsersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  let rows;
  if (actor.role === "admin") {
    rows = await db.select().from(usersTable).orderBy(usersTable.createdAt);
  } else {
    rows = await db.select().from(usersTable)
      .where(eq(usersTable.tenantId, actor.tenantId!))
      .orderBy(usersTable.createdAt);
  }

  if (query.data.role) {
    rows = rows.filter(u => u.role === query.data.role);
  }

  const data = ListUsersResponse.parse({ users: rows, total: rows.length });
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

  // Supervisors can only manage users in their own tenant
  if (actor.role === "supervisor" && target.tenantId !== actor.tenantId) {
    res.status(403).json({ error: "Cannot manage users outside your tenant" });
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
    tenantId: actor.tenantId,
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
    tenantId: updated.tenantId,
    mfaEnabled: updated.mfaEnabled,
    isActive: updated.isActive,
    createdAt: updated.createdAt,
  });
  res.json(data);
});

export default router;
