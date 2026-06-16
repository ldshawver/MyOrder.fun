import { Router, type IRouter } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, rolePermissionsTable, permissionAuditLogsTable } from "@workspace/db";
import { loadDbUser, requireApproved, requireAuth, requireDbUser, requireRole } from "../lib/auth";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_GROUPS, PERMISSION_KEYS, ROLES, normalizeRole, type NormalizedRole } from "../lib/roles";

const router: IRouter = Router();
router.use(requireAuth, loadDbUser, requireDbUser, requireApproved);

let ensured = false;
async function ensureSchema() {
  if (ensured) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "role_permissions" ("id" serial PRIMARY KEY, "tenant_id" integer, "role" text NOT NULL, "permission" text NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "role_permissions_tenant_role_permission_unique" ON "role_permissions" (COALESCE("tenant_id", 0), "role", "permission")`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "permission_audit_logs" ("id" serial PRIMARY KEY, "actor_user_id" integer NOT NULL, "tenant_id" integer, "action" text NOT NULL, "target_role" text NOT NULL, "permission" text NOT NULL, "old_value" boolean, "new_value" boolean, "created_at" timestamp with time zone DEFAULT now() NOT NULL)`);
  ensured = true;
}

function scopeFor(actor: { role: string; tenantId: number | null }, role: NormalizedRole): number | null {
  if (normalizeRole(actor.role) === "global_admin") return null;
  if (role === "global_admin") throw Object.assign(new Error("Admins cannot edit global_admin permissions"), { status: 403 });
  return actor.tenantId ?? null;
}

function canSet(actorRole: NormalizedRole, role: NormalizedRole, permission: string): boolean {
  if (!ROLES.includes(role)) return false;
  if (!PERMISSION_KEYS.includes(permission as never)) return false;
  if (actorRole === "global_admin") return true;
  return role !== "global_admin" && !permission.startsWith("platform.");
}

router.get("/admin/roles-permissions", requireRole("admin"), async (req, res) => {
  await ensureSchema();
  const actor = req.dbUser!;
  const actorRole = normalizeRole(actor.role);
  const tenantId = actorRole === "global_admin" ? null : actor.tenantId ?? null;
  const rows = await db.select().from(rolePermissionsTable).where(tenantId == null ? isNull(rolePermissionsTable.tenantId) : eq(rolePermissionsTable.tenantId, tenantId));
  const overrides = new Map(rows.map((r) => [`${normalizeRole(r.role)}:${r.permission}`, r.enabled]));
  const roles = ROLES.map((role) => ({
    role,
    editable: actorRole === "global_admin" || role !== "global_admin",
    permissions: PERMISSION_KEYS.map((permission) => ({
      permission,
      enabled: overrides.get(`${role}:${permission}`) ?? DEFAULT_ROLE_PERMISSIONS[role].includes(permission),
      editable: canSet(actorRole, role, permission),
    })),
  }));
  res.json({ roles, groups: PERMISSION_GROUPS, defaults: DEFAULT_ROLE_PERMISSIONS, tenantId });
});

router.put("/admin/roles-permissions/:role", requireRole("admin"), async (req, res) => {
  await ensureSchema();
  const actor = req.dbUser!;
  const actorRole = normalizeRole(actor.role);
  const role = normalizeRole(req.params.role);
  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions as { permission: string; enabled: boolean }[] : [];
  let tenantId: number | null;
  try {
    tenantId = scopeFor(actor, role);
  } catch (err) {
    res.status((err as { status?: number }).status ?? 403).json({ error: err instanceof Error ? err.message : "Forbidden" });
    return;
  }
  for (const item of permissions) {
    if (!canSet(actorRole, role, item.permission)) {
      res.status(403).json({ error: "Permission change is not allowed" });
      return;
    }
    const [old] = await db.select().from(rolePermissionsTable).where(and(tenantId == null ? isNull(rolePermissionsTable.tenantId) : eq(rolePermissionsTable.tenantId, tenantId), eq(rolePermissionsTable.role, role), eq(rolePermissionsTable.permission, item.permission))).limit(1);
    const oldValue = old?.enabled ?? DEFAULT_ROLE_PERMISSIONS[role].includes(item.permission as never);
    await db.execute(sql`INSERT INTO "role_permissions" ("tenant_id", "role", "permission", "enabled", "updated_at") VALUES (${tenantId}, ${role}, ${item.permission}, ${Boolean(item.enabled)}, now()) ON CONFLICT (COALESCE("tenant_id", 0), "role", "permission") DO UPDATE SET "enabled" = EXCLUDED."enabled", "updated_at" = now()`);
    await db.insert(permissionAuditLogsTable).values({ actorUserId: actor.id, tenantId, action: "UPDATE_ROLE_PERMISSION", targetRole: role, permission: item.permission, oldValue, newValue: Boolean(item.enabled) });
  }
  res.json({ ok: true });
});

router.post("/admin/roles-permissions/:role/reset", requireRole("admin"), async (req, res) => {
  await ensureSchema();
  const actor = req.dbUser!;
  const role = normalizeRole(req.params.role);
  let tenantId: number | null;
  try {
    tenantId = scopeFor(actor, role);
  } catch (err) {
    res.status((err as { status?: number }).status ?? 403).json({ error: err instanceof Error ? err.message : "Forbidden" });
    return;
  }
  await db.delete(rolePermissionsTable).where(and(tenantId == null ? isNull(rolePermissionsTable.tenantId) : eq(rolePermissionsTable.tenantId, tenantId), eq(rolePermissionsTable.role, role)));
  await db.insert(permissionAuditLogsTable).values({ actorUserId: actor.id, tenantId, action: "RESET_ROLE_PERMISSIONS", targetRole: role, permission: "*", oldValue: null, newValue: null });
  res.json({ ok: true });
});

export default router;
