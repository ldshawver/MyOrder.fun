-- Migration: drop Contractor Hub tables
-- Contractor Hub belongs to a different product and has been removed
-- from the OrderFlow / MyOrder.fun codebase entirely (UI, API, schema).
-- Drop the tables in dependency order: invoices and proposals reference
-- templates, so they must go first.

DROP TABLE IF EXISTS "contractor_invoices";
DROP TABLE IF EXISTS "contractor_proposals";
DROP TABLE IF EXISTS "contractor_templates";
