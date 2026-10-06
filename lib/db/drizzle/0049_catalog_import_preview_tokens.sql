CREATE TABLE IF NOT EXISTS "catalog_import_preview_tokens" (
  "id" bigserial PRIMARY KEY,
  "token_sha256" text NOT NULL UNIQUE,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "actor_id" integer NOT NULL REFERENCES "users"("id"),
  "workbook_sha256" text NOT NULL,
  "preview_request_id" text NOT NULL,
  "expected_inserted" integer NOT NULL,
  "expected_updated" integer NOT NULL,
  "expected_visible" integer NOT NULL,
  "expected_held" integer NOT NULL,
  "expected_duplicates" integer NOT NULL,
  "expected_errors" integer NOT NULL,
  "source_state_sha256" text NOT NULL,
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "confirmation_request_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "catalog_import_preview_tokens_expiry_idx"
  ON "catalog_import_preview_tokens" ("expires_at")
  WHERE "consumed_at" IS NULL;

CREATE INDEX IF NOT EXISTS "catalog_import_preview_tokens_tenant_actor_idx"
  ON "catalog_import_preview_tokens" ("tenant_id", "actor_id", "expires_at")
  WHERE "consumed_at" IS NULL;
