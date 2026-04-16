import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  numeric,
  jsonb,
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
