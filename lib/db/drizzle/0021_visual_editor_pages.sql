CREATE TABLE IF NOT EXISTS "visual_editor_pages" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "draft_data" jsonb NOT NULL DEFAULT '{"root":{"props":{}},"content":[]}'::jsonb,
  "published_data" jsonb,
  "created_by_id" integer REFERENCES "users"("id"),
  "updated_by_id" integer REFERENCES "users"("id"),
  "published_by_id" integer REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS "visual_editor_pages_tenant_slug_unique"
  ON "visual_editor_pages" ("tenant_id", "slug");
