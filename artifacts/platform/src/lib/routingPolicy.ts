export type ApplicationRole = "global_admin" | "admin" | "supervisor" | "csr" | "user";

export function normalizeApplicationRole(role?: string | null): ApplicationRole {
  const normalized = role?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "global_admin") return "global_admin";
  if (normalized === "admin" || normalized === "tenant_admin" || normalized === "manager") return "admin";
  if (normalized === "supervisor") return "supervisor";
  if ([
    "customer_service_rep", "customer_service_representative", "customer_service",
    "customer_service_specialist", "customer_success", "service_rep", "csr", "qsr",
    "staff", "business_sitter", "sales_rep", "lab_tech", "lab_technician",
  ].includes(normalized ?? "")) return "csr";
  return "user";
}

export function canAccessStaffRoute(role?: string | null): boolean {
  return ["global_admin", "admin", "supervisor", "csr"].includes(normalizeApplicationRole(role));
}
