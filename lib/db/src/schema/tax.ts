import { date, foreignKey, integer, numeric, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";
import { inventoryLocationsTable } from "./shifts";

export const taxConfigurationsTable = pgTable("tax_configurations", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  locationId: integer("location_id").notNull(), jurisdiction: text("jurisdiction").notNull(),
  rate: numeric("rate", { precision: 9, scale: 8 }).notNull(), sourcingRule: text("sourcing_rule").notNull(),
  effectiveFrom: date("effective_from").notNull(), effectiveUntil: date("effective_until"),
  sourceName: text("source_name").notNull(), sourceUrl: text("source_url").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(), verifiedByUserId: integer("verified_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  tenantIdUnique: unique("tax_configurations_tenant_id_unique").on(table.tenantId, table.id),
  locationFk: foreignKey({ columns: [table.tenantId, table.locationId], foreignColumns: [inventoryLocationsTable.tenantId, inventoryLocationsTable.id] }),
  verifierFk: foreignKey({ columns: [table.tenantId, table.verifiedByUserId], foreignColumns: [usersTable.tenantId, usersTable.id] }),
}));

export const salesTaxReportingPeriodsTable = pgTable("sales_tax_reporting_periods", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id), locationId: integer("location_id"),
  periodStart: date("period_start").notNull(), periodEnd: date("period_end").notNull(), status: text("status").notNull().default("open"),
  reconciliationDifference: numeric("reconciliation_difference", { precision: 12, scale: 2 }), filedAmount: numeric("filed_amount", { precision: 12, scale: 2 }),
  confirmationReference: text("confirmation_reference"), reviewedByUserId: integer("reviewed_by_user_id"), reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  filedByUserId: integer("filed_by_user_id"), filedAt: timestamp("filed_at", { withTimezone: true }), paidByUserId: integer("paid_by_user_id"), paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => ({
  tenantIdUnique: unique("sales_tax_reporting_periods_tenant_id_unique").on(table.tenantId, table.id),
  periodUnique: unique("sales_tax_reporting_periods_scope_unique").on(table.tenantId, table.locationId, table.periodStart, table.periodEnd),
  locationFk: foreignKey({ columns: [table.tenantId, table.locationId], foreignColumns: [inventoryLocationsTable.tenantId, inventoryLocationsTable.id] }),
}));
