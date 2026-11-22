import { pgTable, serial, integer, text, timestamp, boolean, unique, index } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

/**
 * A short-lived, tenant-owned identity for an assisted guest sale.  The raw
 * tracking capability is never stored: only its SHA-256 digest is durable.
 */
export const guestOrderIdentitiesTable = pgTable("guest_order_identities", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  createdByUserId: integer("created_by_user_id").notNull().references(() => usersTable.id),
  displayName: text("display_name").notNull(),
  phone: text("phone"),
  deliveryAddress: text("delivery_address"),
  trackingTokenHash: text("tracking_token_hash").notNull(),
  trackingExpiresAt: timestamp("tracking_expires_at", { withTimezone: true }).notNull(),
  trackingRevokedAt: timestamp("tracking_revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  tenantIdIdUnique: unique("guest_order_identities_tenant_id_id_unique").on(table.tenantId, table.id),
  tokenHashUnique: unique("guest_order_identities_tracking_token_hash_unique").on(table.trackingTokenHash),
  trackingLookup: index("guest_order_identities_tracking_lookup_idx").on(table.trackingTokenHash, table.trackingExpiresAt),
}));

/** Checkout authority is deliberately distinct from the guest tracking token. */
export const guestCheckoutSessionsTable = pgTable("guest_checkout_sessions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  guestIdentityId: integer("guest_identity_id").notNull().references(() => guestOrderIdentitiesTable.id),
  staffActorUserId: integer("staff_actor_user_id").notNull().references(() => usersTable.id),
  capabilityHash: text("capability_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  idempotencyKey: text("idempotency_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  tenantIdIdUnique: unique("guest_checkout_sessions_tenant_id_id_unique").on(table.tenantId, table.id),
  capabilityHashUnique: unique("guest_checkout_sessions_capability_hash_unique").on(table.capabilityHash),
  actorIdempotencyUnique: unique("guest_checkout_sessions_actor_idempotency_unique").on(table.tenantId, table.staffActorUserId, table.idempotencyKey),
  capabilityLookup: index("guest_checkout_sessions_capability_lookup_idx").on(table.capabilityHash, table.expiresAt),
}));
