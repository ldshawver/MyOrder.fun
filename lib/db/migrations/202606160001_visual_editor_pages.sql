CREATE TABLE IF NOT EXISTS "visual_editor_pages" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "company_id" integer REFERENCES "tenants"("id"),
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "draft_json" jsonb NOT NULL DEFAULT '{"root":{"props":{}},"content":[]}'::jsonb,
  "published_json" jsonb,
  "status" text NOT NULL DEFAULT 'draft',
  "created_by_user_id" integer REFERENCES "users"("id"),
  "updated_by_user_id" integer REFERENCES "users"("id"),
  "published_by_user_id" integer REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp with time zone,
  "archived_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "visual_editor_pages_tenant_slug_unique" ON "visual_editor_pages" ("tenant_id", "slug");
CREATE TABLE IF NOT EXISTS "visual_editor_page_versions" (
  "id" serial PRIMARY KEY NOT NULL,
  "page_id" integer NOT NULL REFERENCES "visual_editor_pages"("id") ON DELETE CASCADE,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "company_id" integer REFERENCES "tenants"("id"),
  "version_json" jsonb NOT NULL,
  "title" text NOT NULL,
  "slug" text NOT NULL,
  "created_by_user_id" integer REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
