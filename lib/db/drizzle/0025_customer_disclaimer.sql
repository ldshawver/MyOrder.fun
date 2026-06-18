ALTER TABLE "admin_settings"
  ADD COLUMN IF NOT EXISTS "customer_disclaimer_text" text NOT NULL DEFAULT 'Before using MyOrder.fun, you confirm that you are authorized to access this customer account, that the information you provide is accurate, and that you agree to follow all applicable terms, privacy, ordering, pickup, and payment policies.';

ALTER TABLE "admin_settings"
  ADD COLUMN IF NOT EXISTS "customer_disclaimer_version" integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS "customer_disclaimer_acceptances" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "disclaimer_version" integer NOT NULL,
  "accepted_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "customer_disclaimer_acceptances_tenant_user_version_idx"
  ON "customer_disclaimer_acceptances" ("tenant_id", "user_id", "disclaimer_version");
