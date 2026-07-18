import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

export const tenantSettingsTable = pgTable("tenant_settings", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  legalBusinessName: text("legal_business_name"),
  publicBusinessName: text("public_business_name"),
  appName: text("app_name"),
  websiteUrl: text("website_url"),
  storefrontUrl: text("storefront_url"),
  supportEmail: text("support_email"),
  supportPhone: text("support_phone"),
  businessAddressJson: jsonb("business_address_json").notNull().default({}),
  timezone: text("timezone").notNull().default("America/Los_Angeles"),
  defaultCurrency: text("default_currency").notNull().default("USD"),
  businessDescription: text("business_description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  version: integer("version").notNull().default(1),
}, (table) => ({
  tenantSettingsTenantUnique: uniqueIndex("tenant_settings_tenant_unique").on(table.tenantId),
  tenantSettingsVersionPositive: check("tenant_settings_version_positive", sql`${table.version} > 0`),
  tenantSettingsCurrencyFormat: check("tenant_settings_currency_format", sql`${table.defaultCurrency} ~ '^[A-Z]{3}$'`),
}));

export type TenantSettings = typeof tenantSettingsTable.$inferSelect;
export type InsertTenantSettings = typeof tenantSettingsTable.$inferInsert;
