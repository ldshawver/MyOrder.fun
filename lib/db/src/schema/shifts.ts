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
  summary: json("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const shiftInventoryItemsTable = pgTable("shift_inventory_items", {
  id: serial("id").primaryKey(),
  shiftId: integer("shift_id").notNull().references(() => labTechShiftsTable.id),
  catalogItemId: integer("catalog_item_id").references(() => catalogItemsTable.id),
  itemName: text("item_name").notNull(),
  unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull().default("0"),
  quantityStart: integer("quantity_start").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LabTechShift = typeof labTechShiftsTable.$inferSelect;
export type ShiftInventoryItem = typeof shiftInventoryItemsTable.$inferSelect;
