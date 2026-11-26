CREATE TABLE "storefront_closures" (
  "tenant_id" integer PRIMARY KEY REFERENCES "tenants" ("id") ON DELETE CASCADE,
  "windows" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "version" integer NOT NULL DEFAULT 1 CONSTRAINT "storefront_closures_version_positive" CHECK ("version" > 0),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "storefront_closures_windows_array" CHECK (jsonb_typeof("windows") = 'array')
);
