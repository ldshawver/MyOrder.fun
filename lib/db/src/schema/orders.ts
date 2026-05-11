import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  numeric,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";
import { catalogItemsTable } from "./catalog";

export const ordersTable = pgTable("orders", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  customerId: integer("customer_id").notNull().references(() => usersTable.id),
  status: text("status").notNull().default("pending"),
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  paymentMethod: text("payment_method").default("cash"), // "cash" | "card" | "comp"
  paymentToken: text("payment_token"),
  paymentIntentId: text("payment_intent_id"),
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull(),
  tax: numeric("tax", { precision: 10, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 10, scale: 2 }).notNull(),
  shippingAddress: text("shipping_address"),
  notes: text("notes"),
  trackingUrl: text("tracking_url"),
  assignedTechId: integer("assigned_tech_id"),
  assignedShiftId: integer("assigned_shift_id"),
  // Fulfillment workflow
  fulfillmentStatus: text("fulfillment_status"), // ready_behind_gate | courier_arrived | handed_off | complete
  // Task #12: Order routing + customer hourglass
  // assignedCsrUserId — the CSR the order was routed to (null = General
  // Account fallback, visible to all CSRs in the queue)
  assignedCsrUserId: integer("assigned_csr_user_id").references(() => usersTable.id),
  // routeSource — provenance of the assignment (per spec):
  //   active_csr          assigned to a CSR who was on shift
  //   general_account     no active CSR; sits in the General Account queue
  //   supervisor_override supervisor manually reassigned the order
  routeSource: text("route_source"),
  routedAt: timestamp("routed_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  // Per-order ETA in minutes; defaults to 30 (also overridable from
  // admin_settings.defaultEtaMinutes at insert time).
  promisedMinutes: integer("promised_minutes").default(30),
  // Computed timestamp = routedAt + promisedMinutes (or default). Stored so
  // the customer hourglass needs no per-tick math on the server.
  estimatedReadyAt: timestamp("estimated_ready_at", { withTimezone: true }),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  // True once supervisor manually adjusts ETA so the auto-eta logic stops overwriting it
  etaAdjustedBySupervisor: boolean("eta_adjusted_by_supervisor").notNull().default(false),
  purgedAt: timestamp("purged_at", { withTimezone: true }),
  auditToken: text("audit_token"),
  // Dual-brand checkout snapshots
  alavontCartSnapshot: jsonb("alavont_cart_snapshot"),
  luciferCheckoutSnapshot: jsonb("lucifer_checkout_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const orderItemsTable = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => ordersTable.id),
  catalogItemId: integer("catalog_item_id").notNull().references(() => catalogItemsTable.id),
  catalogItemName: text("catalog_item_name").notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
  totalPrice: numeric("total_price", { precision: 10, scale: 2 }).notNull(),
  // Dual-brand snapshot at time of order
  alavontName: text("alavont_name"),
  luciferCruzName: text("lucifer_cruz_name"),
  receiptName: text("receipt_name"),
  labelName: text("label_name"),
  labName: text("lab_name"),
  // WooCommerce / CJ Dropshipping linkage — persisted at order time for post-payment dispatch
  wooProductId: text("woo_product_id"),
  wooVariationId: text("woo_variation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orderNotesTable = pgTable("order_notes", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => ordersTable.id),
  authorId: integer("author_id").notNull().references(() => usersTable.id),
  content: text("content").notNull(),
  isEncrypted: text("is_encrypted").notNull().default("false"),
  isInternal: text("is_internal").notNull().default("false"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Order = typeof ordersTable.$inferSelect;
export type InsertOrder = typeof ordersTable.$inferInsert;
export type OrderItem = typeof orderItemsTable.$inferSelect;
export type InsertOrderItem = typeof orderItemsTable.$inferInsert;
export type OrderNote = typeof orderNotesTable.$inferSelect;
export type InsertOrderNote = typeof orderNotesTable.$inferInsert;
