-- Migration 0006: add wc_enabled flag to admin_settings so admins can disable
-- the WooCommerce integration without wiping saved credentials.
ALTER TABLE "admin_settings" ADD COLUMN IF NOT EXISTS "wc_enabled" boolean NOT NULL DEFAULT true;
