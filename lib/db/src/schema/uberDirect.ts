import { bigint, bigserial, foreignKey, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";
import { ordersTable } from "./orders";

export const uberDeliveryQuotesTable = pgTable("uber_delivery_quotes", {
  id: text("id").primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id), customerId: integer("customer_id").notNull().references(() => usersTable.id),
  providerQuoteId: text("provider_quote_id").notNull(), cartFingerprint: text("cart_fingerprint").notNull(), pickupAddress: jsonb("pickup_address").notNull(), dropoffAddress: jsonb("dropoff_address").notNull(), manifestItems: jsonb("manifest_items").notNull(),
  feeCents: integer("fee_cents").notNull(), currency: text("currency").notNull(), providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), status: text("status").notNull().default("quoted"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export const uberDeliveryFulfillmentsTable = pgTable("uber_delivery_fulfillments", {
  id: bigserial("id", { mode: "number" }).primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id), orderId: integer("order_id").notNull(), quoteId: text("quote_id").notNull().references(() => uberDeliveryQuotesTable.id), externalOrderReference: text("external_order_reference").notNull(), providerDeliveryId: text("provider_delivery_id"), providerStatus: text("provider_status"), requestState: text("request_state").notNull().default("delivery_create_pending"), attemptCount: integer("attempt_count").notNull().default(0), lastSanitizedError: text("last_sanitized_error"), lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  order: foreignKey({ name: "uber_delivery_fulfillments_tenant_order_fk", columns: [table.tenantId, table.orderId], foreignColumns: [ordersTable.tenantId, ordersTable.id] }),
  tenantOrder: unique("uber_delivery_fulfillments_tenant_order_unique").on(table.tenantId, table.orderId), externalReference: unique("uber_delivery_fulfillments_external_reference_unique").on(table.externalOrderReference), providerDelivery: unique("uber_delivery_fulfillments_provider_delivery_unique").on(table.providerDeliveryId),
}));

export const uberDeliveryWebhookEventsTable = pgTable("uber_delivery_webhook_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(), providerEventId: text("provider_event_id").notNull(), eventType: text("event_type").notNull(), tenantId: integer("tenant_id").references(() => tenantsTable.id), fulfillmentId: bigint("fulfillment_id", { mode: "number" }).references(() => uberDeliveryFulfillmentsTable.id), providerDeliveryId: text("provider_delivery_id"), providerStatus: text("provider_status"), eventTime: timestamp("event_time", { withTimezone: true }), receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(), processedAt: timestamp("processed_at", { withTimezone: true }),
}, table => ({ providerEvent: unique("uber_delivery_webhook_events_provider_event_unique").on(table.providerEventId) }));
