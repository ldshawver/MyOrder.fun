import {
  pgTable,
  text,
  serial,
  integer,
  numeric,
  jsonb,
  date,
  timestamp,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";
import { contractorTemplatesTable } from "./contractor-hub";
import type { LineItem } from "./contractor-hub";

export const contractorProposalsTable = pgTable("contractor_proposals", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").references(() => tenantsTable.id),
  templateId: integer("template_id").references(() => contractorTemplatesTable.id),
  title: text("title").notNull(),
  status: text("status").notNull().default("draft"),
  clientName: text("client_name"),
  clientEmail: text("client_email"),
  clientCompany: text("client_company"),
  validUntil: date("valid_until"),
  workType: text("work_type"),
  pricingStructure: text("pricing_structure"),
  scope: text("scope"),
  terms: text("terms"),
  paymentTerms: text("payment_terms"),
  notes: text("notes"),
  lineItems: jsonb("line_items").$type<LineItem[]>(),
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }),
  total: numeric("total", { precision: 10, scale: 2 }),
  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type ContractorProposal = typeof contractorProposalsTable.$inferSelect;
export type InsertContractorProposal = typeof contractorProposalsTable.$inferInsert;
