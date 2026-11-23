import { pgTable, text, timestamp, integer, jsonb, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const checkoutQuotesTable = pgTable("checkout_quotes", {
  id: text("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  customerId: integer("customer_id").notNull().references(() => usersTable.id),
  cartFingerprint: text("cart_fingerprint").notNull(),
  locationId: integer("location_id"),
  taxConfigurationId: integer("tax_configuration_id").notNull(),
  quoteSnapshot: jsonb("quote_snapshot").notNull(),
  status: text("status").notNull().default("quoted"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  checkoutLookup: index("checkout_quotes_checkout_lookup_idx").on(table.tenantId, table.customerId, table.status, table.expiresAt),
  statusCheck: check("checkout_quotes_status_check", sql`${table.status} IN ('quoted', 'consumed')`),
}));
