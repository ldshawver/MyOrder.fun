import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  boolean,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkId: text("clerk_id").notNull().unique(),
  email: text("email"),
  normalizedEmail: text("normalized_email"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  role: text("role").notNull().default("user"),
  tenantId: integer("tenant_id").references(() => tenantsTable.id),
  mfaEnabled: boolean("mfa_enabled").notNull().default(false),
  mfaSecret: text("mfa_secret"),
  mfaBackupCodes: text("mfa_backup_codes"),
  contactPhone: text("contact_phone"),
  avatarUrl: text("avatar_url"),
  notificationPreferences: jsonb("notification_preferences").default({
    orderAlerts: "sound",
    platformUpdates: "in_app",
  }),
  status: text("status").notNull().default("pending"),
  isActive: boolean("is_active").notNull().default(true),
  isDefaultTech: boolean("is_default_tech").notNull().default(false),
  identityStatus: text("identity_status").notNull().default("verification_pending"),
  provisioningStatus: text("provisioning_status").notNull().default("pending"),
  provisioningError: text("provisioning_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  tenantIdIdUnique: unique("users_tenant_id_id_unique").on(table.tenantId, table.id),
}));

export const clerkWebhookEventsTable = pgTable("clerk_webhook_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  clerkUserId: text("clerk_user_id"),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  status: text("status").notNull().default("processed"),
  error: text("error"),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = typeof insertUserSchema._output;
export type User = typeof usersTable.$inferSelect;
