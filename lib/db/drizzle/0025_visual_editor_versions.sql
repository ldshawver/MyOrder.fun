DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'visual_editor_pages' AND column_name = 'draft_data')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'visual_editor_pages' AND column_name = 'draft_json') THEN
    ALTER TABLE "visual_editor_pages" RENAME COLUMN "draft_data" TO "draft_json";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'visual_editor_pages' AND column_name = 'published_data')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'visual_editor_pages' AND column_name = 'published_json') THEN
    ALTER TABLE "visual_editor_pages" RENAME COLUMN "published_data" TO "published_json";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'visual_editor_pages' AND column_name = 'created_by_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'visual_editor_pages' AND column_name = 'created_by_user_id') THEN
    ALTER TABLE "visual_editor_pages" RENAME COLUMN "created_by_id" TO "created_by_user_id";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'visual_editor_pages' AND column_name = 'updated_by_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'visual_editor_pages' AND column_name = 'updated_by_user_id') THEN
    ALTER TABLE "visual_editor_pages" RENAME COLUMN "updated_by_id" TO "updated_by_user_id";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'visual_editor_pages' AND column_name = 'published_by_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'visual_editor_pages' AND column_name = 'published_by_user_id') THEN
    ALTER TABLE "visual_editor_pages" RENAME COLUMN "published_by_id" TO "published_by_user_id";
  END IF;
END $$;

ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "draft_json" jsonb NOT NULL DEFAULT '{"root":{"props":{}},"content":[]}'::jsonb;
ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "published_json" jsonb;
ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "created_by_user_id" integer REFERENCES "users"("id");
ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "updated_by_user_id" integer REFERENCES "users"("id");
ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "published_by_user_id" integer REFERENCES "users"("id");
ALTER TABLE "visual_editor_pages" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;

UPDATE "visual_editor_pages"
SET "created_by_user_id" = (SELECT MIN("id") FROM "users")
WHERE "created_by_user_id" IS NULL
  AND EXISTS (SELECT 1 FROM "users");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "visual_editor_pages" WHERE "created_by_user_id" IS NULL) THEN
    ALTER TABLE "visual_editor_pages" ALTER COLUMN "created_by_user_id" SET NOT NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "visual_editor_page_versions" (
  "id" serial PRIMARY KEY NOT NULL,
  "page_id" integer NOT NULL REFERENCES "visual_editor_pages"("id"),
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "version_number" integer NOT NULL,
  "content_json" jsonb NOT NULL,
  "created_by_user_id" integer NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "note" text
);
CREATE UNIQUE INDEX IF NOT EXISTS "visual_editor_page_versions_page_number_unique"
  ON "visual_editor_page_versions" ("page_id", "version_number");
