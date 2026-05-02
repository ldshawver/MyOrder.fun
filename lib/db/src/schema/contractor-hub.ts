import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";

export const contractorTemplatesTable = pgTable("contractor_templates", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id"),
  name: text("name").notNull(),
  templateType: text("template_type").notNull(),
  styleLevel: text("style_level").notNull(),
  description: text("description"),
  workType: text("work_type"),
  pricingStructure: text("pricing_structure"),
  defaultScope: text("default_scope"),
  defaultTerms: text("default_terms"),
  defaultPaymentTerms: text("default_payment_terms"),
  defaultNotes: text("default_notes"),
  defaultLineItems: jsonb("default_line_items").$type<LineItem[]>(),
  brandingEnabled: boolean("branding_enabled").notNull().default(false),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type LineItem = {
  description: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
};

export type ContractorTemplate = typeof contractorTemplatesTable.$inferSelect;
export type InsertContractorTemplate = typeof contractorTemplatesTable.$inferInsert;
