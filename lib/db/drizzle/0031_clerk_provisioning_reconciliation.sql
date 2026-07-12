ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "normalized_email" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "identity_status" text NOT NULL DEFAULT 'verification_pending';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "provisioning_status" text NOT NULL DEFAULT 'pending';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "provisioning_error" text;
UPDATE "users" SET "normalized_email" = lower(trim("email")) WHERE "normalized_email" IS NULL AND "email" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "users_normalized_email_unique" ON "users" ("normalized_email") WHERE "normalized_email" IS NOT NULL;
CREATE TABLE IF NOT EXISTS "clerk_webhook_events" (
  "id" text PRIMARY KEY,
  "event_type" text NOT NULL,
  "clerk_user_id" text,
  "processed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status" text NOT NULL DEFAULT 'processed',
  "error" text
);
