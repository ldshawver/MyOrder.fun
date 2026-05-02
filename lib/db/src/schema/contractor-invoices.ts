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
import { contractorProposalsTable } from "./contractor-proposals";
import type { LineItem } from "./contractor-hub";

export const contractorInvoicesTable = pgTable("contractor_invoices", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").references(() => tenantsTable.id),
  proposalId: integer("proposal_id").references(() => contractorProposalsTable.id),
  templateId: integer("template_id").references(() => contractorTemplatesTable.id),
  title: text("title").notNull(),
  invoiceNumber: text("invoice_number"),
  status: text("status").notNull().default("draft"),
  clientName: text("client_name"),
  clientEmail: text("client_email"),
  clientCompany: text("client_company"),
  issueDate: date("issue_date"),
  dueDate: date("due_date"),
  pricingStructure: text("pricing_structure"),
  paymentTerms: text("payment_terms"),
  notes: text("notes"),
  lineItems: jsonb("line_items").$type<LineItem[]>(),
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }),
  taxAmount: numeric("tax_amount", { precision: 10, scale: 2 }).default("0"),
  discountAmount: numeric("discount_amount", { precision: 10, scale: 2 }).default("0"),
  total: numeric("total", { precision: 10, scale: 2 }),
  amountPaid: numeric("amount_paid", { precision: 10, scale: 2 }).default("0"),
  balanceDue: numeric("balance_due", { precision: 10, scale: 2 }),
  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type ContractorInvoice = typeof contractorInvoicesTable.$inferSelect;
export type InsertContractorInvoice = typeof contractorInvoicesTable.$inferInsert;
