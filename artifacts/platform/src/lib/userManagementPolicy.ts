import { normalizeApplicationRole } from "./routingPolicy";

export function assignableRolesForActor(role?: string | null): readonly string[] {
  const actorRole = normalizeApplicationRole(role);
  if (actorRole === "supervisor") return ["user", "csr"];
  if (actorRole === "admin") return ["user", "csr", "supervisor", "admin"];
  if (actorRole === "global_admin") return ["user", "csr", "supervisor", "admin", "global_admin"];
  return [];
}

export function canAssignRoleFromUserManagement(actorRole: string | null | undefined, targetRole: string): boolean {
  return assignableRolesForActor(actorRole).includes(targetRole);
}
