import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  numeric,
  json,
  boolean,
  uniqueIndex,
  unique,
  foreignKey,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";
import { catalogItemsTable } from "./catalog";

// ─── CSR Sales Boxes ──────────────────────────────────────────────────────────
// Tenant-scoped physical/logical boxes that CSRs are assigned to during a shift.
// Admins create/edit/deactivate; CSRs read active ones at clock-in.
export const csrBoxesTable = pgTable("csr_boxes", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  // Stable slug used as boxAssignmentId in lab_tech_shifts (e.g. "sales-box-1")
  slug: text("slug").notNull(),
  label: text("label").notNull(),
  description: text("description"),
  location: text("location"),
  isActive: boolean("is_active").notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  tenantIdIdUnique: unique("csr_boxes_tenant_id_id_unique").on(table.tenantId, table.id),
}));

export type CsrBox = typeof csrBoxesTable.$inferSelect;
export type InsertCsrBox = typeof csrBoxesTable.$inferInsert;

// ─── Inventory Locations ──────────────────────────────────────────────────────
// Physical or logical storage locations: CSR boxes, storefront, backstock.
// Only Alavont products (is_woo_managed=false) use this model.
export const inventoryLocationsTable = pgTable("inventory_locations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  // 'csr_box' | 'storefront' | 'backstock'
  type: text("type").notNull(),
  // Set only when type='csr_box'; links to the csr_boxes row
  csrBoxId: integer("csr_box_id").references(() => csrBoxesTable.id),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  tenantIdIdUnique: unique("inventory_locations_tenant_id_id_unique").on(table.tenantId, table.id),
}));

export type InventoryLocation = typeof inventoryLocationsTable.$inferSelect;
export type InsertInventoryLocation = typeof inventoryLocationsTable.$inferInsert;

// ─── Inventory Balances ───────────────────────────────────────────────────────
// Per-product, per-location quantity tracking.
// Master total = SUM(quantity_on_hand) across active locations.
export const inventoryBalancesTable = pgTable("inventory_balances", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  productId: integer("product_id").notNull().references(() => catalogItemsTable.id),
  locationId: integer("location_id").notNull().references(() => inventoryLocationsTable.id),
  quantityOnHand: numeric("quantity_on_hand", { precision: 10, scale: 3 }).notNull().default("0"),
  parLevel: numeric("par_level", { precision: 10, scale: 2 }).notNull().default("0"),
  inventoryKind: text("inventory_kind").notNull().default("sellable_catalog"),
  isSellable: boolean("is_sellable").notNull().default(true),
  quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
  quarantinedByUserId: integer("quarantined_by_user_id").references(() => usersTable.id),
  quarantineReason: text("quarantine_reason"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type InventoryBalance = typeof inventoryBalancesTable.$inferSelect;
export type InsertInventoryBalance = typeof inventoryBalancesTable.$inferInsert;

export const labTechShiftsTable = pgTable("lab_tech_shifts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  techId: integer("tech_id").notNull().references(() => usersTable.id),
  // status: active | clocked_out | supervisor_pending | finalized
  status: text("status").notNull().default("active"),
  ipAddress: text("ip_address"),
  boxAssignmentId: text("box_assignment_id"),
  setupJson: json("setup_json").default({}),
  clockedInAt: timestamp("clocked_in_at", { withTimezone: true }).notNull().defaultNow(),
  clockedOutAt: timestamp("clocked_out_at", { withTimezone: true }),
  // Cash bank tracking
  cashBankStart: numeric("cash_bank_start", { precision: 10, scale: 2 }).default("0"),
  cashBankEnd: numeric("cash_bank_end", { precision: 10, scale: 2 }),
  // Rep-reported ending cash bank (separate from system-computed)
  cashBankEndReported: numeric("cash_bank_end_reported", { precision: 10, scale: 2 }),
  // Supervisor checkout fields
  tipPercentSelected: numeric("tip_percent_selected", { precision: 5, scale: 2 }),
  tipAmount: numeric("tip_amount", { precision: 10, scale: 2 }),
  differenceAmount: numeric("difference_amount", { precision: 10, scale: 2 }).default("0"),
  depositAmount: numeric("deposit_amount", { precision: 10, scale: 2 }),
  supervisorId: integer("supervisor_id").references(() => usersTable.id),
  supervisorConfirmedAt: timestamp("supervisor_confirmed_at", { withTimezone: true }),
  // Payment method breakdown: { cash, card, cashapp, paypal, venmo, comp, other }
  paymentTotalsJson: json("payment_totals_json"),
  summary: json("summary"),
  // CSR personal delivery opt-in (set at clock-in)
  csrDeliveryOptIn: boolean("csr_delivery_opt_in").notNull().default(false),
  // Running total of delivery fees earned by this CSR this shift (all go to CSR as gratuity)
  csrDeliveryEarnings: numeric("csr_delivery_earnings", { precision: 10, scale: 2 }).default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// A General Queue session is an alternative cash-accountability context for
// orders claimed while no CSR shift is authoritative. It deliberately shares
// the canonical cash ledger; it is not a second payment ledger.
export const generalQueueCashSessionsTable = pgTable("general_queue_cash_sessions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  locationId: integer("location_id").notNull().references(() => inventoryLocationsTable.id),
  registerBoxId: integer("register_box_id").references(() => csrBoxesTable.id),
  status: text("status").notNull().default("open"),
  openedByUserId: integer("opened_by_user_id").notNull().references(() => usersTable.id),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  openingBalance: numeric("opening_balance", { precision: 10, scale: 2 }).notNull().default("0"),
  closedByUserId: integer("closed_by_user_id").references(() => usersTable.id),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closingBalance: numeric("closing_balance", { precision: 10, scale: 2 }),
  expectedBalance: numeric("expected_balance", { precision: 10, scale: 2 }),
  differenceAmount: numeric("difference_amount", { precision: 10, scale: 2 }),
  openIdempotencyKey: text("open_idempotency_key"),
  closeIdempotencyKey: text("close_idempotency_key"),
  discrepancyReason: text("discrepancy_reason"),
  paymentTotalsJson: json("payment_totals_json").default({}),
  summary: json("summary").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  tenantLocationStatusIdx: uniqueIndex("general_queue_cash_sessions_open_location_uq")
    .on(table.tenantId, table.locationId)
    .where(sql`${table.status} = 'open'`),
  openIdempotencyIdx: uniqueIndex("general_queue_cash_sessions_open_idempotency_uq")
    .on(table.tenantId, table.openIdempotencyKey).where(sql`${table.openIdempotencyKey} IS NOT NULL`),
  closeIdempotencyIdx: uniqueIndex("general_queue_cash_sessions_close_idempotency_uq")
    .on(table.tenantId, table.closeIdempotencyKey).where(sql`${table.closeIdempotencyKey} IS NOT NULL`),
  tenantIdIdUnique: unique("general_queue_cash_sessions_tenant_id_id_unique").on(table.tenantId, table.id),
  statusCheck: check("general_queue_cash_sessions_status_check", sql`${table.status} IN ('open', 'closed')`),
  tenantLocationFk: foreignKey({
    name: "gq_sessions_tenant_location_fk",
    columns: [table.tenantId, table.locationId],
    foreignColumns: [inventoryLocationsTable.tenantId, inventoryLocationsTable.id],
  }),
  tenantRegisterBoxFk: foreignKey({
    name: "gq_sessions_tenant_register_box_fk",
    columns: [table.tenantId, table.registerBoxId],
    foreignColumns: [csrBoxesTable.tenantId, csrBoxesTable.id],
  }),
  tenantOpenedByUserFk: foreignKey({
    name: "gq_sessions_tenant_opened_by_user_fk",
    columns: [table.tenantId, table.openedByUserId],
    foreignColumns: [usersTable.tenantId, usersTable.id],
  }),
  tenantClosedByUserFk: foreignKey({
    name: "gq_sessions_tenant_closed_by_user_fk",
    columns: [table.tenantId, table.closedByUserId],
    foreignColumns: [usersTable.tenantId, usersTable.id],
  }),
}));

export const generalQueueCashSessionParticipantsTable = pgTable("general_queue_cash_session_participants", {
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  sessionId: integer("session_id").notNull().references(() => generalQueueCashSessionsTable.id),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  joinedByUserId: integer("joined_by_user_id").notNull().references(() => usersTable.id),
  leftAt: timestamp("left_at", { withTimezone: true }),
}, (table) => ({
  pk: primaryKey({ columns: [table.sessionId, table.userId] }),
  tenantSessionFk: foreignKey({
    name: "gq_participants_tenant_session_fk",
    columns: [table.tenantId, table.sessionId],
    foreignColumns: [generalQueueCashSessionsTable.tenantId, generalQueueCashSessionsTable.id],
  }),
  tenantUserFk: foreignKey({
    name: "gq_participants_tenant_user_fk",
    columns: [table.tenantId, table.userId],
    foreignColumns: [usersTable.tenantId, usersTable.id],
  }),
  tenantJoinedByUserFk: foreignKey({
    name: "gq_participants_tenant_joined_by_user_fk",
    columns: [table.tenantId, table.joinedByUserId],
    foreignColumns: [usersTable.tenantId, usersTable.id],
  }),
}));

export type GeneralQueueCashSession = typeof generalQueueCashSessionsTable.$inferSelect;

export const shiftRoutingConfigTable = pgTable("shift_routing_config", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  allowMultipleActiveShifts: boolean("allow_multiple_active_shifts").notNull().default(false),
  routingStrategy: text("routing_strategy").notNull(),
  approvedByUserId: integer("approved_by_user_id").references(() => usersTable.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ─── Inventory Template ───────────────────────────────────────────────────────
// Canonical list of inventory rows seeded from the spreadsheet.
// Admins can edit labels, default quantities, and ordering.
export const inventoryTemplatesTable = pgTable("inventory_templates", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  sectionName: text("section_name"),
  itemName: text("item_name"),
  rowType: text("row_output").notNull().default("item"), // "section" | "item" | "spacer" | "cash"
  unitType: text("unit_output").default("#"),            // "G" | "#"
  startingQuantityDefault: numeric("starting_quantity_default", { precision: 10, scale: 3 }).default("0"),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  catalogItemId: integer("catalog_item_id").references(() => catalogItemsTable.id),
  alavontId: text("alavont_id"),
  deductionUnitType: text("deduction_unit_output").default("#"),
  deductionQuantityPerSale: numeric("deduction_quantity_per_sale", { precision: 10, scale: 3 }).default("1"),
  // Pricing from the CSR cash box spreadsheet
  menuPrice: numeric("menu_price", { precision: 10, scale: 2 }),    // customer-facing price
  payoutPrice: numeric("payout_price", { precision: 10, scale: 2 }), // rep payout / commission price
  // Live running stock — decremented automatically when linked catalog items are sold
  currentStock: numeric("current_stock", { precision: 10, scale: 3 }),
  // Par level — minimum desired quantity; drives restock slip generation at shift close
  parLevel: numeric("par_level", { precision: 10, scale: 2 }).default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// ─── Shift Inventory Items ────────────────────────────────────────────────────
// Snapshot of inventory taken at clock-in; updated at clock-out with sold/end qty.
export const shiftInventoryItemsTable = pgTable("shift_inventory_items", {
  id: serial("id").primaryKey(),
  shiftId: integer("shift_id").notNull().references(() => labTechShiftsTable.id),
  // Template linkage (nullable for legacy shifts)
  templateItemId: integer("template_item_id").references(() => inventoryTemplatesTable.id),
  // Display structure
  sectionName: text("section_name"),
  rowType: text("row_output").default("item"),    // "section" | "item" | "spacer" | "cash"
  unitType: text("unit_output").default("#"),     // "G" | "#"
  displayOrder: integer("display_order").default(0),
  // Product linkage
  catalogItemId: integer("catalog_item_id").references(() => catalogItemsTable.id),
  itemName: text("item_name").notNull(),
  // Quantities — numeric to support grams
  unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull().default("0"),
  quantityStart: numeric("quantity_start", { precision: 10, scale: 3 }).notNull().default("0"),
  quantitySold: numeric("quantity_sold", { precision: 10, scale: 3 }).default("0"),
  // quantityEnd = computed (start - sold); quantityEndActual = physically counted at clock-out
  quantityEnd: numeric("quantity_end", { precision: 10, scale: 3 }),
  quantityEndActual: numeric("quantity_end_actual", { precision: 10, scale: 3 }),
  // discrepancy = quantityEnd (expected) - quantityEndActual (physical), positive = shortage
  discrepancy: numeric("discrepancy", { precision: 10, scale: 3 }),
  isFlagged: boolean("is_flagged").default(false), // negative ending inventory or discrepancy
  // Location linkage: which box/storefront/backstock this snapshot row tracks
  locationId: integer("location_id").references(() => inventoryLocationsTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LabTechShift = typeof labTechShiftsTable.$inferSelect;
export type InventoryTemplate = typeof inventoryTemplatesTable.$inferSelect;
export type ShiftInventoryItem = typeof shiftInventoryItemsTable.$inferSelect;
