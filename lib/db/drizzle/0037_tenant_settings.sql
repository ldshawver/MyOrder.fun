CREATE TABLE IF NOT EXISTS "tenant_settings" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "legal_business_name" text,
  "public_business_name" text,
  "app_name" text,
  "website_url" text,
  "storefront_url" text,
  "support_email" text,
  "support_phone" text,
  "business_address_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "timezone" text NOT NULL DEFAULT 'America/Los_Angeles',
  "default_currency" text NOT NULL DEFAULT 'USD',
  "business_description" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "version" integer NOT NULL DEFAULT 1,
  CONSTRAINT "tenant_settings_version_positive" CHECK ("version" > 0),
  CONSTRAINT "tenant_settings_currency_format" CHECK ("default_currency" ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_settings_tenant_unique" ON "tenant_settings" ("tenant_id");

INSERT INTO "tenant_settings" (
  "tenant_id",
  "public_business_name",
  "app_name",
  "timezone",
  "default_currency",
  "version"
)
SELECT
  t."id",
  t."name",
  t."name",
  'America/Los_Angeles',
  'USD',
  1
FROM "tenants" t
WHERE NOT EXISTS (
  SELECT 1 FROM "tenant_settings" ts WHERE ts."tenant_id" = t."id"
);
