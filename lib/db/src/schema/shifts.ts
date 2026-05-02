import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  numeric,
  json,
  boolean,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";
import { catalogItemsTable } from "./catalog";

export const labTechShiftsTable = pgTable("lab_tech_shifts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  techId: integer("tech_id").notNull().references(() => usersTable.id),
  // status: active | clocked_out | supervisor_pending | finalized
  status: text("status").notNull().default("active"),
  ipAddress: text("ip_address"),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LabTechShift = typeof labTechShiftsTable.$inferSelect;
export type InventoryTemplate = typeof inventoryTemplatesTable.$inferSelect;
export type ShiftInventoryItem = typeof shiftInventoryItemsTable.$inferSelect;
