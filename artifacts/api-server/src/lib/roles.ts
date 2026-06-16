import type { Request, Response, NextFunction } from "express";
import * as dbModule from "@workspace/db";
import type { User } from "@workspace/db";
import { and, eq, isNull, or } from "drizzle-orm";

const db = dbModule.db;
function optionalDbExport<T>(key: string): T | undefined {
  try {
    return (dbModule as unknown as Record<string, T | undefined>)[key];
  } catch {
    return undefined;
  }
}
const rolePermissionsTable = optionalDbExport<{ tenantId: never; role: never; permission: never; id?: never }>("rolePermissionsTable");
const usersTable = optionalDbExport<{ role: never; tenantId: never }>("usersTable");

export const ROLE_USER = "user" as const;
export const ROLE_CSR = "csr" as const;
export const ROLE_SUPERVISOR = "supervisor" as const;
export const ROLE_ADMIN = "admin" as const;
export const ROLE_GLOBAL_ADMIN = "global_admin" as const;

export const CANONICAL_ROLES = [
  ROLE_USER,
  ROLE_CSR,
  ROLE_SUPERVISOR,
  ROLE_ADMIN,
  ROLE_GLOBAL_ADMIN,
] as const;
export type CanonicalRole = typeof CANONICAL_ROLES[number];
export type NormalizedRole = CanonicalRole;
export type Role = CanonicalRole;
export const ROLES = CANONICAL_ROLES;

export const LEGACY_ROLE_ALIASES: Record<string, Role> = {
  user: ROLE_USER,
  customer: ROLE_USER,
  normal_user: ROLE_USER,
  csr: ROLE_CSR,
  customer_service_rep: ROLE_CSR,
  customer_service_representative: ROLE_CSR,
  customer_service: ROLE_CSR,
  customer_service_specialist: ROLE_CSR,
  customer_success: ROLE_CSR,
  service_rep: ROLE_CSR,
  qsr: ROLE_CSR,
  staff: ROLE_CSR,
  business_sitter: ROLE_CSR,
  sales_rep: ROLE_CSR,
  lab_tech: ROLE_CSR,
  lab_technician: ROLE_CSR,
  supervisor: ROLE_SUPERVISOR,
  admin: ROLE_ADMIN,
  manager: ROLE_ADMIN,
  tenant_admin: ROLE_ADMIN,
  global_admin: ROLE_GLOBAL_ADMIN,
  super_admin: ROLE_GLOBAL_ADMIN,
  platform_admin: ROLE_GLOBAL_ADMIN,
};

export function normalizeRole(role: unknown): Role {
  const normalized = typeof role === "string" ? role.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return LEGACY_ROLE_ALIASES[normalized] ?? ROLE_USER;
}

export function isKnownRole(role: unknown): boolean {
  if (role == null) return false;
  const normalized = typeof role === "string" ? role.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return normalized in LEGACY_ROLE_ALIASES;
}

export function isGlobalAdmin(user: Pick<User, "role"> | null | undefined): boolean {
  return normalizeRole(user?.role) === ROLE_GLOBAL_ADMIN;
}

export function isGlobalAdminRole(role: unknown): boolean {
  return normalizeRole(role) === ROLE_GLOBAL_ADMIN;
}

export function hasRole(user: Pick<User, "role"> | null | undefined, roles: readonly Role[]): boolean {
  const role = normalizeRole(user?.role);
  return roles.includes(role) || (role === ROLE_GLOBAL_ADMIN && roles.includes(ROLE_ADMIN));
}

export function hasRoleValue(role: unknown, roles: readonly Role[]): boolean {
  const normalized = normalizeRole(role);
  return roles.includes(normalized) || (normalized === ROLE_GLOBAL_ADMIN && roles.includes(ROLE_ADMIN));
}

export const PERMISSIONS = [
  "users.view_self", "users.view_team", "users.view_tenant", "users.manage_team", "users.manage_tenant", "users.manage_roles", "users.manage_permissions",
  "orders.view_self", "orders.view_team", "orders.view_tenant", "orders.create", "orders.update", "orders.cancel", "orders.refund",
  "customers.view", "customers.create", "customers.update", "customers.delete",
  "feedback.submit", "feedback.admin_view", "feedback.review", "feedback.archive", "feedback.create_ticket",
  "schedules.view_self", "schedules.view_team", "schedules.view_tenant", "schedules.create", "schedules.update", "schedules.approve", "schedules.publish",
  "timeclock.clock_self", "timeclock.view_team", "timeclock.approve_team", "timeclock.view_tenant",
  "reports.view_self", "reports.view_team", "reports.view_tenant", "reports.export",
  "settings.view", "settings.manage_tenant", "billing.manage", "audit_logs.view", "app_doctor.view", "app_doctor.run",
  "platform.tenants.view", "platform.tenants.manage", "platform.impersonate", "platform.global_settings.manage",
] as const;
export type Permission = typeof PERMISSIONS[number];
export const PERMISSION_KEYS = PERMISSIONS;
export type PermissionKey = Permission;
export const PLATFORM_PERMISSIONS = PERMISSIONS.filter((p) => p.startsWith("platform."));

const userPerms = ["feedback.submit", "users.view_self", "orders.view_self", "schedules.view_self", "timeclock.clock_self", "reports.view_self"] satisfies Permission[];
const csrExtra = ["customers.view", "customers.create", "customers.update", "orders.create", "orders.update", "schedules.view_team", "reports.view_team"] satisfies Permission[];
const supervisorExtra = ["users.view_team", "users.manage_team", "schedules.create", "schedules.update", "schedules.approve", "timeclock.view_team", "timeclock.approve_team"] satisfies Permission[];
const adminExtra = PERMISSIONS.filter((p) => !p.startsWith("platform.")) as Permission[];

export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  user: userPerms,
  csr: [...new Set([...userPerms, ...csrExtra])],
  supervisor: [...new Set([...userPerms, ...csrExtra, ...supervisorExtra])],
  admin: adminExtra,
  global_admin: [...PERMISSIONS],
};

export const PERMISSION_GROUPS = PERMISSIONS.reduce<Record<string, Permission[]>>((acc, permission) => {
  const group = permission.split(".")[0] ?? "other";
  (acc[group] ??= []).push(permission);
  return acc;
}, {});

export function defaultHasPermission(role: unknown, permission: string): boolean {
  const normalized = normalizeRole(role);
  return (DEFAULT_ROLE_PERMISSIONS[normalized] as readonly string[]).includes(permission);
}

export async function hasPermission(user: Pick<User, "role" | "tenantId"> | null | undefined, permission: string, tenantId?: number | null): Promise<boolean> {
  if (!user) return false;
  const role = normalizeRole(user.role);
  if (role === ROLE_GLOBAL_ADMIN) return true;
  if (PLATFORM_PERMISSIONS.includes(permission as Permission)) return false;
  const scopedTenantId = tenantId ?? user.tenantId ?? null;
  if (scopedTenantId != null && user.tenantId != null && scopedTenantId !== user.tenantId) return false;
  if (!rolePermissionsTable?.role) {
    return defaultHasPermission(role, permission);
  }
  const rows = await db.select().from(rolePermissionsTable as never).where(and(
    eq(rolePermissionsTable.role, role),
    eq(rolePermissionsTable.permission, permission),
    scopedTenantId == null ? isNull(rolePermissionsTable.tenantId) : or(isNull(rolePermissionsTable.tenantId), eq(rolePermissionsTable.tenantId, scopedTenantId)),
  ));
  const permissionRows = rows as Array<{ tenantId: number | null; enabled: boolean }>;
  const tenantOverride = permissionRows.find((row) => row.tenantId === scopedTenantId);
  const globalOverride = permissionRows.find((row) => row.tenantId == null);
  return (tenantOverride ?? globalOverride)?.enabled ?? defaultHasPermission(role, permission);
}

export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.dbUser;
    if (!user) return void res.status(401).json({ error: "Unauthorized" });
    if (!(await hasPermission(user, permission, user.tenantId))) return void res.status(403).json({ error: "Forbidden: missing permission", permission });
    next();
  };
}

export function requireTenantScope(req: Request, res: Response, next: NextFunction): void {
  const user = req.dbUser;
  const tenantId = Number(req.params.tenantId ?? req.params.id ?? req.query.tenantId);
  if (!user) return void res.status(401).json({ error: "Unauthorized" });
  if (!Number.isFinite(tenantId) || isGlobalAdmin(user) || user.tenantId === tenantId) return next();
  res.status(403).json({ error: "Forbidden: cross-tenant access denied" });
}

export async function countRoleUsers(role: Role, tenantId: number | null | undefined): Promise<number> {
  if (!usersTable) return 0;
  const rows = await db.select({ role: usersTable.role }).from(usersTable as never).where(tenantId == null ? eq(usersTable.role, role) : eq(usersTable.tenantId, tenantId));
  return (rows as Array<{ role: string }>).filter((row) => normalizeRole(row.role) === role).length;
}
