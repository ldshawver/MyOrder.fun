CREATE TABLE IF NOT EXISTS "catalog_import_snapshots" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "actor_id" integer REFERENCES "users"("id"),
  "action" text NOT NULL DEFAULT 'catalog_import',
  "file_name" text,
  "snapshot" jsonb NOT NULL,
  "rolled_back_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "catalog_import_snapshots_tenant_created_idx"
  ON "catalog_import_snapshots" ("tenant_id", "created_at" DESC);
