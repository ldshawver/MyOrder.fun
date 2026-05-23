ALTER TABLE "catalog_items"
  ADD COLUMN IF NOT EXISTS "media_gallery" jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "is_featured" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "is_sale_featured" boolean NOT NULL DEFAULT false;

ALTER TABLE "admin_settings"
  ADD COLUMN IF NOT EXISTS "catalog_banner_images" text;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "notification_preferences" jsonb DEFAULT '{"orderAlerts":"sound","platformUpdates":"in_app"}'::jsonb;
