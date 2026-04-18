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
  status: text("status").notNull().default("active"),
  ipAddress: text("ip_address"),
  clockedInAt: timestamp("clocked_in_at", { withTimezone: true }).notNull().defaultNow(),
  clockedOutAt: timestamp("clocked_out_at", { withTimezone: true }),
  // Cash bank tracking
  cashBankStart: numeric("cash_bank_start", { precision: 10, scale: 2 }).default("0"),
  cashBankEnd: numeric("cash_bank_end", { precision: 10, scale: 2 }),
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
  rowType: text("row_type").notNull().default("item"), // "section" | "item" | "spacer" | "cash"
  unitType: text("unit_type").default("#"),            // "G" | "#"
  startingQuantityDefault: numeric("starting_quantity_default", { precision: 10, scale: 3 }).default("0"),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  catalogItemId: integer("catalog_item_id").references(() => catalogItemsTable.id),
  alavontId: text("alavont_id"),
  deductionUnitType: text("deduction_unit_type").default("#"),
  deductionQuantityPerSale: numeric("deduction_quantity_per_sale", { precision: 10, scale: 3 }).default("1"),
  // Live running stock — decremented automatically when linked catalog items are sold
  currentStock: numeric("current_stock", { precision: 10, scale: 3 }),
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
  rowType: text("row_type").default("item"),    // "section" | "item" | "spacer" | "cash"
  unitType: text("unit_type").default("#"),     // "G" | "#"
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
