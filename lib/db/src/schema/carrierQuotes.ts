import { check, index, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

/**
 * Server-side authority for Lucifer Direct carrier rates. Only a trusted
 * carrier adapter may create these records; browser checkout receives the
 * opaque id and cannot author price, service, destination, or expiry data.
 */
export const carrierQuotesTable = pgTable("carrier_quotes", {
  id: text("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  customerId: integer("customer_id").notNull().references(() => usersTable.id),
  provider: text("provider").notNull(),
  providerQuoteId: text("provider_quote_id").notNull(),
  serviceSnapshot: jsonb("service_snapshot").notNull(),
  destinationSnapshot: jsonb("destination_snapshot").notNull(),
  cartFingerprint: text("cart_fingerprint").notNull(),
  feeCents: integer("fee_cents").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull().default("quoted"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  checkoutLookup: index("carrier_quotes_checkout_lookup_idx").on(table.tenantId, table.customerId, table.status, table.expiresAt),
  providerQuote: unique("carrier_quotes_tenant_provider_quote_unique").on(table.tenantId, table.provider, table.providerQuoteId),
  feeCheck: check("carrier_quotes_fee_check", sql`${table.feeCents} >= 0`),
  currencyCheck: check("carrier_quotes_currency_check", sql`${table.currency} ~ '^[a-z]{3}$'`),
  statusCheck: check("carrier_quotes_status_check", sql`${table.status} IN ('quoted', 'consumed')`),
}));
