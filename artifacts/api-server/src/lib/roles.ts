export const ROLE_USER = "user" as const;
export const ROLE_CSR = "csr" as const;
export const ROLE_SUPERVISOR = "supervisor" as const;
export const ROLE_ADMIN = "admin" as const;
export const ROLE_GLOBAL_ADMIN = "global_admin" as const;

export const CANONICAL_ROLES = [
  "user",
  "csr",
  "supervisor",
  "admin",
  "global_admin",
] as const;
export type CanonicalRole = typeof CANONICAL_ROLES[number];
export const ROLES = CANONICAL_ROLES;
export type NormalizedRole = CanonicalRole;

const ROLE_ALIASES: Record<string, CanonicalRole> = {
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

export function normalizeRole(role: unknown): CanonicalRole {
  const key = typeof role === "string" ? role.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return ROLE_ALIASES[key] ?? ROLE_USER;
}

export function isKnownRole(role: unknown): boolean {
  if (role == null) return false;
  const key = typeof role === "string" ? role.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  return key in ROLE_ALIASES;
}

export function isGlobalAdminRole(role: unknown): boolean {
  return normalizeRole(role) === ROLE_GLOBAL_ADMIN;
}

export function hasRoleValue(role: unknown, roles: readonly CanonicalRole[]): boolean {
  const normalized = normalizeRole(role);
  return roles.includes(normalized) || (normalized === ROLE_GLOBAL_ADMIN && roles.includes(ROLE_ADMIN));
}

export const PERMISSION_KEYS = [
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
export type PermissionKey = typeof PERMISSION_KEYS[number];

const user = ["feedback.submit", "users.view_self", "orders.view_self", "schedules.view_self", "timeclock.clock_self", "reports.view_self"] satisfies PermissionKey[];
const csr = [...user, "customers.view", "customers.create", "customers.update", "orders.create", "orders.update", "schedules.view_team", "reports.view_team"] satisfies PermissionKey[];
const supervisor = [...csr, "users.view_team", "users.manage_team", "schedules.create", "schedules.update", "schedules.approve", "timeclock.view_team", "timeclock.approve_team"] satisfies PermissionKey[];
const admin = PERMISSION_KEYS.filter((p) => !p.startsWith("platform.")) as PermissionKey[];
const globalAdmin = [...PERMISSION_KEYS] as PermissionKey[];

export const DEFAULT_ROLE_PERMISSIONS: Record<CanonicalRole, readonly PermissionKey[]> = {
  [ROLE_USER]: user,
  [ROLE_CSR]: csr,
  [ROLE_SUPERVISOR]: supervisor,
  [ROLE_ADMIN]: admin,
  [ROLE_GLOBAL_ADMIN]: globalAdmin,
};

export const PERMISSION_GROUPS = PERMISSION_KEYS.reduce<Record<string, PermissionKey[]>>((acc, permission) => {
  const group = permission.split(".")[0] ?? "other";
  (acc[group] ??= []).push(permission);
  return acc;
}, {});

export function defaultHasPermission(role: unknown, permission: string): boolean {
  const normalized = normalizeRole(role);
  return (DEFAULT_ROLE_PERMISSIONS[normalized] as readonly string[]).includes(permission);
}
