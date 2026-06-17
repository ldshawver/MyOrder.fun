import { Router } from "express";
import { z } from "zod";
import { db, rolePermissionsTable, permissionAuditLogsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { loadDbUser, requireApproved, requireAuth, requireDbUser } from "../lib/auth";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, PLATFORM_PERMISSIONS, ROLES, isGlobalAdmin, normalizeRole, requirePermission, ROLE_GLOBAL_ADMIN, type Permission, type Role } from "../lib/roles";

const router = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

const permissionEnum = z.enum(PERMISSIONS);
const permissionPatchSchema = z.object({
  tenantId: z.number().int().positive().nullable().optional(),
  permissions: z.record(permissionEnum, z.boolean()).refine((permissions) => Object.keys(permissions).length > 0, "At least one permission is required"),
}).strict();
const resetSchema = z.object({ tenantId: z.number().int().positive().nullable().optional() }).strict();
const listQuerySchema = z.object({ tenantId: z.coerce.number().int().positive().optional() }).strict();

function groupedPermissions() {
  return PERMISSIONS.reduce<Record<string, string[]>>((acc, permission) => {
    const group = permission.split(".")[0] ?? "other";
    (acc[group] ??= []).push(permission);
    return acc;
  }, {});
}

function canEdit(actor: NonNullable<Express.Request["dbUser"]>, role: string, permission?: string): string | null {
  const actorRole = normalizeRole(actor.role);
  const targetRole = normalizeRole(role);
  if (actorRole !== "admin" && actorRole !== "global_admin") return "Only admins can edit permissions";
  if (actorRole === "admin") {
    if (targetRole === ROLE_GLOBAL_ADMIN) return "Tenant admins cannot edit global_admin permissions";
    if (permission && PLATFORM_PERMISSIONS.includes(permission as Permission)) return "Tenant admins cannot grant platform permissions";
  }
  return null;
}

function tenantScopeFor(actor: NonNullable<Express.Request["dbUser"]>, requestedTenantId?: number | null): { tenantId: number | null } | { error: string } {
  if (isGlobalAdmin(actor)) return { tenantId: requestedTenantId ?? null };
  if (requestedTenantId !== undefined && requestedTenantId !== actor.tenantId) return { error: "Tenant admins cannot modify another tenant's permissions" };
  if (actor.tenantId == null) return { error: "Tenant admin is not assigned to a tenant" };
  return { tenantId: actor.tenantId };
}

function assertSafeAdminPermissionChange(role: Role, permission: string, enabled: boolean): string | null {
  if (role !== "admin" || enabled) return null;
  if (permission === "users.manage_roles" || permission === "users.manage_permissions") {
    return "Cannot disable core admin role/permission management defaults; this prevents tenant lockout";
  }
  return null;
}

router.get("/admin/roles-permissions", requirePermission("users.manage_permissions"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
  const scope = tenantScopeFor(actor, parsed.data.tenantId);
  if ("error" in scope) return void res.status(403).json({ error: scope.error });

  const tenantId = scope.tenantId;
  const rows = await db.select().from(rolePermissionsTable).where(tenantId == null ? isNull(rolePermissionsTable.tenantId) : eq(rolePermissionsTable.tenantId, tenantId));
  const roles = ROLES.map((role) => ({
    role,
    editable: canEdit(actor, role) == null,
    permissions: PERMISSIONS.map((permission) => {
      const override = rows.find((row) => normalizeRole(row.role) === role && row.permission === permission);
      const defaultEnabled = (DEFAULT_ROLE_PERMISSIONS[role] as readonly string[]).includes(permission);
      return { key: permission, permission, enabled: override?.enabled ?? defaultEnabled, defaultEnabled, overridden: Boolean(override), editable: canEdit(actor, role, permission) == null };
    }),
  }));
  const groups = groupedPermissions();
  res.json({ roles, permissions: groups, groups, tenantId, warnings: { admin: "Changing admin permissions can lock tenant managers out. Keep users.manage_roles and users.manage_permissions enabled." } });
});

router.put("/admin/roles-permissions/:role", requirePermission("users.manage_permissions"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const role = normalizeRole(req.params.role);
  const parsed = permissionPatchSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  const actorError = canEdit(actor, role);
  if (actorError) return void res.status(403).json({ error: actorError });
  const scope = tenantScopeFor(actor, parsed.data.tenantId);
  if ("error" in scope) return void res.status(403).json({ error: scope.error });
  const tenantId = scope.tenantId;

  for (const [permission, enabled] of Object.entries(parsed.data.permissions)) {
    const permissionError = canEdit(actor, role, permission);
    if (permissionError) return void res.status(403).json({ error: permissionError, permission });
    const safetyError = assertSafeAdminPermissionChange(role, permission, enabled);
    if (safetyError) return void res.status(409).json({ error: safetyError, permission });
    const where = and(eq(rolePermissionsTable.role, role), eq(rolePermissionsTable.permission, permission), tenantId == null ? isNull(rolePermissionsTable.tenantId) : eq(rolePermissionsTable.tenantId, tenantId));
    const [oldRow] = await db.select().from(rolePermissionsTable).where(where).limit(1);
    if (oldRow) {
      await db.update(rolePermissionsTable).set({ enabled, updatedAt: new Date() }).where(eq(rolePermissionsTable.id, oldRow.id));
    } else {
      await db.insert(rolePermissionsTable).values({ tenantId, role, permission, enabled });
    }
    await db.insert(permissionAuditLogsTable).values({ actorUserId: actor.id, tenantId, action: "permission.updated", targetRole: role, permission, oldValue: oldRow?.enabled ?? (DEFAULT_ROLE_PERMISSIONS[role] as readonly string[]).includes(permission), newValue: enabled });
  }
  res.json({ ok: true });
});

router.post("/admin/roles-permissions/:role/reset", requirePermission("users.manage_permissions"), async (req, res): Promise<void> => {
  const actor = req.dbUser!;
  const role = normalizeRole(req.params.role);
  const parsed = resetSchema.safeParse(req.body ?? {});
  if (!parsed.success) return void res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  const actorError = canEdit(actor, role);
  if (actorError) return void res.status(403).json({ error: actorError });
  const scope = tenantScopeFor(actor, parsed.data.tenantId);
  if ("error" in scope) return void res.status(403).json({ error: scope.error });
  const tenantId = scope.tenantId;
  await db.delete(rolePermissionsTable).where(and(eq(rolePermissionsTable.role, role), tenantId == null ? isNull(rolePermissionsTable.tenantId) : eq(rolePermissionsTable.tenantId, tenantId)));
  await db.insert(permissionAuditLogsTable).values({ actorUserId: actor.id, tenantId, action: "permission.reset_defaults", targetRole: role, permission: "*" });
  res.json({ ok: true });
});

export default router;
