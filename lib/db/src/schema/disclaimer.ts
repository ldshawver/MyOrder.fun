import {
  pgTable,
  serial,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const customerDisclaimerAcceptancesTable = pgTable("customer_disclaimer_acceptances", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  disclaimerVersion: integer("disclaimer_version").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantUserVersionIdx: uniqueIndex("customer_disclaimer_acceptances_tenant_user_version_idx").on(
    table.tenantId,
    table.userId,
    table.disclaimerVersion,
  ),
}));

export type CustomerDisclaimerAcceptance = typeof customerDisclaimerAcceptancesTable.$inferSelect;
export type InsertCustomerDisclaimerAcceptance = typeof customerDisclaimerAcceptancesTable.$inferInsert;
