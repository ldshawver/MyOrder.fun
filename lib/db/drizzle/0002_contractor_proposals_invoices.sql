-- Migration: contractor_proposals and contractor_invoices tables
-- Additive-only — all statements use IF NOT EXISTS for safety.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contractor_proposals" (
  "id"                serial PRIMARY KEY,
  "tenant_id"         integer REFERENCES "tenants"("id"),
  "template_id"       integer REFERENCES "contractor_templates"("id"),
  "title"             text NOT NULL,
  "status"            text NOT NULL DEFAULT 'draft',
  "client_name"       text,
  "client_email"      text,
  "client_company"    text,
  "valid_until"       date,
  "work_type"         text,
  "pricing_structure" text,
  "scope"             text,
  "terms"             text,
  "payment_terms"     text,
  "notes"             text,
  "line_items"        jsonb,
  "subtotal"          numeric(10,2),
  "total"             numeric(10,2),
  "created_by"        integer REFERENCES "users"("id"),
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contractor_proposals_tenant_idx"
  ON "contractor_proposals" ("tenant_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contractor_invoices" (
  "id"                serial PRIMARY KEY,
  "tenant_id"         integer REFERENCES "tenants"("id"),
  "proposal_id"       integer REFERENCES "contractor_proposals"("id"),
  "template_id"       integer REFERENCES "contractor_templates"("id"),
  "title"             text NOT NULL,
  "invoice_number"    text,
  "status"            text NOT NULL DEFAULT 'draft',
  "client_name"       text,
  "client_email"      text,
  "client_company"    text,
  "issue_date"        date,
  "due_date"          date,
  "pricing_structure" text,
  "payment_terms"     text,
  "notes"             text,
  "line_items"        jsonb,
  "subtotal"          numeric(10,2),
  "tax_amount"        numeric(10,2) DEFAULT 0,
  "discount_amount"   numeric(10,2) DEFAULT 0,
  "total"             numeric(10,2),
  "amount_paid"       numeric(10,2) DEFAULT 0,
  "balance_due"       numeric(10,2),
  "created_by"        integer REFERENCES "users"("id"),
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contractor_invoices_tenant_idx"
  ON "contractor_invoices" ("tenant_id");
