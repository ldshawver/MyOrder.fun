import { check, foreignKey, integer, jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenants";
import { inventoryLocationsTable } from "./shifts";

export const locationPickupSchedulesTable = pgTable("location_pickup_schedules", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  locationId: integer("location_id").notNull(),
  timeZone: text("time_zone").notNull(),
  weeklyHours: jsonb("weekly_hours").notNull().default([]),
  exceptions: jsonb("exceptions").notNull().default([]),
  slotMinutes: integer("slot_minutes").notNull().default(30),
  maxAdvanceDays: integer("max_advance_days").notNull().default(14),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => ({
  tenantLocationUnique: unique("location_pickup_schedules_tenant_location_unique").on(table.tenantId, table.locationId),
  tenantLocation: foreignKey({ name: "location_pickup_schedules_tenant_location_fk", columns: [table.tenantId, table.locationId], foreignColumns: [inventoryLocationsTable.tenantId, inventoryLocationsTable.id] }).onDelete("cascade"),
  slotMinutesCheck: check("location_pickup_schedules_slot_minutes_check", sql`${table.slotMinutes} IN (10, 15, 20, 30, 45, 60)`),
  maxAdvanceDaysCheck: check("location_pickup_schedules_max_advance_days_check", sql`${table.maxAdvanceDays} BETWEEN 1 AND 90`),
  versionCheck: check("location_pickup_schedules_version_check", sql`${table.version} > 0`),
}));

export type LocationPickupSchedule = typeof locationPickupSchedulesTable.$inferSelect;
