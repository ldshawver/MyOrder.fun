import { check, foreignKey, index, integer, numeric, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";
import { ordersTable } from "./orders";

export const paymentAttemptsTable = pgTable("payment_attempts", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  orderId: integer("order_id").notNull(), provider: text("provider").notNull(), providerEnvironment: text("provider_environment").notNull(),
  providerOrderId: text("provider_order_id"), idempotencyKey: text("idempotency_key").notNull(),
  fundingSource: text("funding_source"),
  requestedAmount: numeric("requested_amount", { precision: 12, scale: 2 }).notNull(), requestedCurrency: text("requested_currency").notNull(),
  capturedAmount: numeric("captured_amount", { precision: 12, scale: 2 }), capturedCurrency: text("captured_currency"),
  state: text("state").notNull().default("creating"), reconciliationState: text("reconciliation_state").notNull().default("not_required"),
  failureClass: text("failure_class"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => ({
  tenantIdUnique: unique("payment_attempts_tenant_id_unique").on(table.tenantId, table.id),
  idempotencyUnique: unique("payment_attempts_tenant_order_key_unique").on(table.tenantId, table.orderId, table.idempotencyKey),
  providerOrderUnique: unique("payment_attempts_provider_order_unique").on(table.provider, table.providerEnvironment, table.providerOrderId),
  orderFk: foreignKey({ name: "payment_attempts_tenant_order_fk", columns: [table.tenantId, table.orderId], foreignColumns: [ordersTable.tenantId, ordersTable.id] }),
  orderIndex: index("payment_attempts_order_idx").on(table.tenantId, table.orderId, table.createdAt),
  amountCheck: check("payment_attempts_amount_check", sql`${table.requestedAmount} > 0`),
}));

export const paymentCapturesTable = pgTable("payment_captures", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  paymentAttemptId: integer("payment_attempt_id").notNull(), provider: text("provider").notNull(), providerEnvironment: text("provider_environment").notNull(),
  providerCaptureId: text("provider_capture_id").notNull(), amount: numeric("amount", { precision: 12, scale: 2 }).notNull(), currency: text("currency").notNull(),
  state: text("state").notNull(), capturedAt: timestamp("captured_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  tenantIdUnique: unique("payment_captures_tenant_id_unique").on(table.tenantId, table.id),
  providerCaptureUnique: unique("payment_captures_provider_capture_unique").on(table.provider, table.providerEnvironment, table.providerCaptureId),
  attemptFk: foreignKey({ name: "payment_captures_tenant_attempt_fk", columns: [table.tenantId, table.paymentAttemptId], foreignColumns: [paymentAttemptsTable.tenantId, paymentAttemptsTable.id] }),
}));

export const paymentRefundsTable = pgTable("payment_refunds", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id), paymentCaptureId: integer("payment_capture_id").notNull(),
  providerRefundId: text("provider_refund_id"), idempotencyKey: text("idempotency_key").notNull(), amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull(), reason: text("reason").notNull(), state: text("state").notNull().default("requested"), failureClass: text("failure_class"),
  // This is the provider operation identity, not the caller's local replay key.
  // It is allocated and committed before the provider POST and never changes.
  providerRequestId: text("provider_request_id"), providerStatus: text("provider_status"), providerResultAt: timestamp("provider_result_at", { withTimezone: true }), requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(), locallyFinalizedAt: timestamp("locally_finalized_at", { withTimezone: true }),
  actorUserId: integer("actor_user_id").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => ({
  tenantIdUnique: unique("payment_refunds_tenant_id_unique").on(table.tenantId, table.id),
  idempotencyUnique: unique("payment_refunds_tenant_capture_key_unique").on(table.tenantId, table.paymentCaptureId, table.idempotencyKey),
  providerRequestUnique: unique("payment_refunds_provider_request_unique").on(table.providerRequestId),
  providerRefundUnique: unique("payment_refunds_provider_refund_unique").on(table.providerRefundId),
  captureFk: foreignKey({ name: "payment_refunds_tenant_capture_fk", columns: [table.tenantId, table.paymentCaptureId], foreignColumns: [paymentCapturesTable.tenantId, paymentCapturesTable.id] }),
  actorFk: foreignKey({ name: "payment_refunds_tenant_actor_fk", columns: [table.tenantId, table.actorUserId], foreignColumns: [usersTable.tenantId, usersTable.id] }),
}));

export const paymentWebhookEventsTable = pgTable("payment_webhook_events", {
  id: serial("id").primaryKey(), provider: text("provider").notNull(), providerEnvironment: text("provider_environment").notNull(), providerEventId: text("provider_event_id").notNull(),
  eventType: text("event_type").notNull(), providerOrderId: text("provider_order_id"), providerCaptureId: text("provider_capture_id"), providerRefundId: text("provider_refund_id"), tenantId: integer("tenant_id").references(() => tenantsTable.id),
  paymentAttemptId: integer("payment_attempt_id"), paymentRefundId: integer("payment_refund_id"), processingState: text("processing_state").notNull().default("received"), failureClass: text("failure_class"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(), processedAt: timestamp("processed_at", { withTimezone: true }),
}, table => ({
  eventUnique: unique("payment_webhook_provider_event_unique").on(table.provider, table.providerEnvironment, table.providerEventId),
  attemptFk: foreignKey({ name: "payment_webhook_tenant_attempt_fk", columns: [table.tenantId, table.paymentAttemptId], foreignColumns: [paymentAttemptsTable.tenantId, paymentAttemptsTable.id] }),
  refundFk: foreignKey({ name: "payment_webhook_tenant_refund_fk", columns: [table.tenantId, table.paymentRefundId], foreignColumns: [paymentRefundsTable.tenantId, paymentRefundsTable.id] }),
  lookupIndex: index("payment_webhook_lookup_idx").on(table.provider, table.providerEnvironment, table.providerOrderId, table.providerCaptureId),
}));
