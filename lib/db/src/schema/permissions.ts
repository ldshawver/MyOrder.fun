import { pgTable, text, serial, timestamp, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const rolePermissionsTable = pgTable("role_permissions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").references(() => tenantsTable.id),
  role: text("role").notNull(),
  permission: text("permission").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  rolePermissionTenantUnique: uniqueIndex("role_permissions_tenant_role_permission_unique").on(table.tenantId, table.role, table.permission),
}));

export const permissionAuditLogsTable = pgTable("permission_audit_logs", {
  id: serial("id").primaryKey(),
  actorUserId: integer("actor_user_id").notNull(),
  tenantId: integer("tenant_id").references(() => tenantsTable.id),
  action: text("action").notNull(),
  targetRole: text("target_role").notNull(),
  permission: text("permission").notNull(),
  oldValue: boolean("old_value"),
  newValue: boolean("new_value"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
