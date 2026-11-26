import { sql } from "drizzle-orm";
import { bigint, bigserial, check, foreignKey, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { orderFulfillmentGroupsTable, ordersTable } from "./orders";
import { tenantsTable } from "./tenants";

export const cjOrderFulfillmentsTable = pgTable("cj_order_fulfillments", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  orderId: integer("order_id").notNull(),
  fulfillmentGroupId: integer("fulfillment_group_id").notNull(),
  providerOrderId: text("provider_order_id").notNull(),
  providerStatus: text("provider_status").notNull().default("pending"),
  reconciliationState: text("reconciliation_state").notNull().default("pending"),
  lastProviderEventAt: timestamp("last_provider_event_at", { withTimezone: true }),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => ({
  tenantOrderFk: foreignKey({ name: "cj_order_fulfillments_tenant_order_fk", columns: [table.tenantId, table.orderId], foreignColumns: [ordersTable.tenantId, ordersTable.id] }),
  groupFk: foreignKey({ name: "cj_order_fulfillments_group_fk", columns: [table.orderId, table.fulfillmentGroupId], foreignColumns: [orderFulfillmentGroupsTable.orderId, orderFulfillmentGroupsTable.id] }),
  tenantGroup: unique("cj_order_fulfillments_tenant_group_unique").on(table.tenantId, table.fulfillmentGroupId),
  tenantProviderOrder: unique("cj_order_fulfillments_tenant_provider_order_unique").on(table.tenantId, table.providerOrderId),
  tenantIdId: unique("cj_order_fulfillments_tenant_id_id_unique").on(table.tenantId, table.id),
  statusCheck: check("cj_order_fulfillments_status_check", sql`${table.providerStatus} IN ('pending', 'processing', 'on_hold', 'completed', 'cancelled', 'failed', 'refunded')`),
  reconciliationCheck: check("cj_order_fulfillments_reconciliation_check", sql`${table.reconciliationState} IN ('pending', 'in_sync', 'reconciliation_required')`),
  reconciliationIndex: index("cj_order_fulfillments_reconciliation_idx").on(table.tenantId, table.reconciliationState, table.updatedAt),
}));

export const cjFulfillmentEventsTable = pgTable("cj_fulfillment_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  fulfillmentId: bigint("fulfillment_id", { mode: "number" }).notNull(),
  providerEventId: text("provider_event_id").notNull(),
  eventType: text("event_type").notNull(),
  providerOrderId: text("provider_order_id").notNull(),
  providerStatus: text("provider_status").notNull(),
  payloadSha256: text("payload_sha256").notNull(),
  providerEventAt: timestamp("provider_event_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, table => ({
  tenantFulfillmentFk: foreignKey({ name: "cj_fulfillment_events_tenant_fulfillment_fk", columns: [table.tenantId, table.fulfillmentId], foreignColumns: [cjOrderFulfillmentsTable.tenantId, cjOrderFulfillmentsTable.id] }),
  tenantEvent: unique("cj_fulfillment_events_tenant_event_unique").on(table.tenantId, table.providerEventId),
  payloadHashCheck: check("cj_fulfillment_events_payload_sha256_check", sql`${table.payloadSha256} ~ '^[0-9a-f]{64}$'`),
  lookupIndex: index("cj_fulfillment_events_lookup_idx").on(table.tenantId, table.providerOrderId, table.receivedAt),
}));
