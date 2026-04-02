import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { tenantsTable } from "./tenants";

export const onboardingRequestsTable = pgTable("onboarding_requests", {
  id: serial("id").primaryKey(),
  companyName: text("company_name").notNull(),
  contactName: text("contact_name").notNull(),
  contactEmail: text("contact_email").notNull(),
  contactPhone: text("contact_phone"),
  businessType: text("business_type").notNull(),
  website: text("website"),
  description: text("description"),
  expectedOrderVolume: text("expected_order_volume"),
  status: text("status").notNull().default("submitted"),
  reviewNotes: text("review_notes"),
  reviewedBy: integer("reviewed_by").references(() => usersTable.id),
  tenantId: integer("tenant_id").references(() => tenantsTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertOnboardingRequestSchema = createInsertSchema(onboardingRequestsTable).omit({
  id: true, createdAt: true, updatedAt: true, reviewedBy: true, tenantId: true,
});
export type InsertOnboardingRequest = z.infer<typeof insertOnboardingRequestSchema>;
export type OnboardingRequest = typeof onboardingRequestsTable.$inferSelect;
