-- Migration: contractor_templates table + platform-default seed data
-- Additive-only — all statements use IF NOT EXISTS for safety on existing databases.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contractor_templates" (
  "id"                    serial PRIMARY KEY,
  "company_id"            integer,
  "name"                  text NOT NULL,
  "template_type"         text NOT NULL,
  "style_level"           text NOT NULL,
  "description"           text,
  "work_type"             text,
  "pricing_structure"     text,
  "default_scope"         text,
  "default_terms"         text,
  "default_payment_terms" text,
  "default_notes"         text,
  "default_line_items"    jsonb,
  "branding_enabled"      boolean NOT NULL DEFAULT false,
  "is_default"            boolean NOT NULL DEFAULT false,
  "is_active"             boolean NOT NULL DEFAULT true,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
-- Dedup index: one platform default per (template_type, style_level)
CREATE UNIQUE INDEX IF NOT EXISTS "contractor_templates_platform_uniq"
  ON "contractor_templates" ("template_type", "style_level")
  WHERE "company_id" IS NULL;

--> statement-breakpoint
-- ── Platform-default seed templates ────────────────────────────────────────
-- 4 Proposal templates
INSERT INTO "contractor_templates"
  ("company_id","name","template_type","style_level","description","work_type","pricing_structure",
   "default_scope","default_terms","default_payment_terms","default_notes","default_line_items",
   "branding_enabled","is_default","is_active")
VALUES
  -- 1. Minimal Proposal
  (NULL,
   'Minimal Proposal', 'proposal', 'minimal',
   'Quick, simple proposal for straightforward work.',
   'General', 'Fixed price',
   'Provide contracted services as described. All work performed in a professional and workmanlike manner.',
   'Proposal valid for 30 days from issue date. Work commences upon signed approval.',
   '50% deposit due upon signing. Remaining balance due upon project completion.',
   'Any changes to scope may affect pricing and timeline. A change order will be issued for additional work.',
   '[{"description":"Contracted services","quantity":1,"unit":"project","rate":0,"amount":0}]',
   false, true, true),

  -- 2. Standard Proposal
  (NULL,
   'Standard Proposal', 'proposal', 'standard',
   'Full-featured proposal for most contractor jobs.',
   'General contracting', 'Fixed price with itemized labor and materials',
   E'Provide all labor, materials, and supervision required to complete the project as specified.\n\nScope includes:\n1. Site preparation\n2. Materials procurement\n3. Installation / implementation\n4. Cleanup and final walkthrough\n\nAll work will meet applicable local codes and standards.',
   'Proposal valid for 30 days. Changes to scope require a written change order approved by both parties. Contractor is not responsible for delays caused by client or third-party factors outside contractor''s control.',
   '50% deposit due at signing. 25% due at midpoint milestone. 25% due upon completion and client acceptance.',
   'Project timeline assumes timely site access and prompt client decisions. Permit costs, if required, are not included and will be billed at cost.',
   '[{"description":"Labor","quantity":1,"unit":"hour","rate":0,"amount":0},{"description":"Materials / supplies","quantity":1,"unit":"item","rate":0,"amount":0}]',
   false, true, true),

  -- 3. Detailed Proposal
  (NULL,
   'Detailed Proposal', 'proposal', 'detailed',
   'Comprehensive proposal for complex or higher-value work.',
   'Complex projects', 'Milestone-based billing with labor and materials breakdown',
   E'Background:\nThis proposal covers the full scope of services as agreed upon during discovery.\n\nScope of Work:\n1. Discovery and planning\n2. Labor and implementation\n3. Materials procurement and management\n4. Quality assurance and testing\n5. Final delivery and client sign-off\n\nExclusions:\nPermits and fees (billed at cost), pre-existing structural deficiencies, work outside the defined project boundary.\n\nDeliverables:\n- Completed work per specification\n- As-built documentation (if applicable)\n- Warranty documentation',
   E'Proposal valid for 30 days. All changes to scope must be agreed in writing via formal change order prior to execution.\n\nWarranty: Contractor warrants all work for 12 months from completion against defects in workmanship. Material warranties are passed through from manufacturers.\n\nDependencies: Client is responsible for site access, utilities, and any required permits unless otherwise stated.',
   '30% deposit due at signing. Progress payments due at each milestone. Final 10% retainer due upon punch-list completion and written acceptance.',
   'Milestone schedule and payment amounts will be finalized in the executed contract. Change orders priced at current labor rates. Unforeseen site conditions may require a scope revision.',
   '[{"description":"Discovery / planning","quantity":1,"unit":"phase","rate":0,"amount":0},{"description":"Labor / implementation","quantity":1,"unit":"hour","rate":0,"amount":0},{"description":"Materials / expenses","quantity":1,"unit":"item","rate":0,"amount":0},{"description":"Change order allowance","quantity":1,"unit":"allowance","rate":0,"amount":0}]',
   false, true, true),

  -- 4. Branded Proposal
  (NULL,
   'Branded Proposal', 'proposal', 'branded',
   'Polished proposal with company logo, brand colors, and contact block.',
   'General contracting', 'Fixed price with itemized labor and materials',
   E'Provide all labor, materials, and supervision required to complete the project as specified.\n\nScope includes:\n1. Site preparation\n2. Materials procurement\n3. Installation / implementation\n4. Cleanup and final walkthrough\n\nAll work will meet applicable local codes and standards.',
   'Proposal valid for 30 days. Changes to scope require a written change order approved by both parties.',
   '50% deposit due at signing. 25% due at midpoint milestone. 25% due upon completion and client acceptance.',
   'This proposal includes company branding. Update your logo, colors, and contact information in company settings.',
   '[{"description":"Labor","quantity":1,"unit":"hour","rate":0,"amount":0},{"description":"Materials / supplies","quantity":1,"unit":"item","rate":0,"amount":0}]',
   true, true, true)

ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- 4 Invoice templates
INSERT INTO "contractor_templates"
  ("company_id","name","template_type","style_level","description","work_type","pricing_structure",
   "default_scope","default_terms","default_payment_terms","default_notes","default_line_items",
   "branding_enabled","is_default","is_active")
VALUES
  -- 5. Minimal Invoice
  (NULL,
   'Minimal Invoice', 'invoice', 'minimal',
   'Simple invoice for quick, straightforward billing.',
   NULL, 'Flat rate',
   NULL, NULL,
   'Payment due within 30 days of invoice date. Accepted: check, bank transfer, or as arranged.',
   'Thank you for your business.',
   '[{"description":"Services rendered","quantity":1,"unit":"project","rate":0,"amount":0}]',
   false, true, true),

  -- 6. Standard Invoice
  (NULL,
   'Standard Invoice', 'invoice', 'standard',
   'Itemized invoice with labor, materials, taxes, and balance due.',
   NULL, 'Itemized labor and materials',
   NULL, NULL,
   'Net 30. Payment due within 30 days of invoice date. Late payments subject to 1.5% monthly finance charge. Accepted: check, ACH, or credit card (3% processing fee applies).',
   'Please reference the invoice number on your payment. Contact us with any questions.',
   '[{"description":"Approved labor","quantity":1,"unit":"hour","rate":0,"amount":0},{"description":"Approved materials","quantity":1,"unit":"item","rate":0,"amount":0}]',
   false, true, true),

  -- 7. Detailed Invoice
  (NULL,
   'Detailed Invoice', 'invoice', 'detailed',
   'Comprehensive invoice with milestone tracking, expenses, discounts, and payment history.',
   NULL, 'Milestone-based with expense reimbursement',
   NULL, NULL,
   'Net 30 from invoice date. All previous payments credited as shown. Balance due payable by check or ACH. A 1.5% monthly finance charge applies after 30 days.',
   'This invoice reflects work completed per the signed proposal and any approved change orders. Reimbursable expenses billed at cost — receipts available upon request.',
   '[{"description":"Milestone 1 — labor","quantity":1,"unit":"phase","rate":0,"amount":0},{"description":"Milestone 2 — labor","quantity":1,"unit":"phase","rate":0,"amount":0},{"description":"Materials","quantity":1,"unit":"item","rate":0,"amount":0},{"description":"Reimbursable expenses","quantity":1,"unit":"item","rate":0,"amount":0},{"description":"Discount / adjustment","quantity":1,"unit":"item","rate":0,"amount":0}]',
   false, true, true),

  -- 8. Branded Invoice
  (NULL,
   'Branded Invoice', 'invoice', 'branded',
   'Polished invoice with company logo, contact block, and remittance instructions.',
   NULL, 'Itemized labor and materials',
   NULL, NULL,
   'Net 30. Please make checks payable to [Company Name] or pay online at [payment link]. Reference invoice number on all payments.',
   'This invoice includes company branding. Update your logo, colors, and remittance details in company settings. Thank you for choosing us.',
   '[{"description":"Approved labor","quantity":1,"unit":"hour","rate":0,"amount":0},{"description":"Approved materials","quantity":1,"unit":"item","rate":0,"amount":0}]',
   true, true, true)

ON CONFLICT DO NOTHING;
