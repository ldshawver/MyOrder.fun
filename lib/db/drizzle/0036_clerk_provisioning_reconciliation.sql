-- Add Clerk identity/provisioning state while retaining duplicate source emails
-- for manual reconciliation. No email address is deleted or rewritten.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "normalized_email" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "identity_status" text NOT NULL DEFAULT 'verification_pending';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "provisioning_status" text NOT NULL DEFAULT 'pending';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "provisioning_error" text;

WITH normalized AS (
  SELECT
    "id",
    lower(trim("email")) AS normalized_email,
    count(*) OVER (PARTITION BY lower(trim("email"))) AS normalized_count
  FROM "users"
  WHERE nullif(trim("email"), '') IS NOT NULL
)
UPDATE "users" u
SET "normalized_email" = n.normalized_email
FROM normalized n
WHERE n."id" = u."id"
  AND n.normalized_count = 1
  AND u."normalized_email" IS NULL;

WITH duplicate_ids AS (
  SELECT "id"
  FROM (
    SELECT
      "id",
      count(*) OVER (PARTITION BY lower(trim("email"))) AS normalized_count
    FROM "users"
    WHERE nullif(trim("email"), '') IS NOT NULL
  ) candidates
  WHERE normalized_count > 1
)
UPDATE "users" u
SET
  "normalized_email" = NULL,
  "identity_status" = 'identity_mismatch',
  "provisioning_status" = 'provisioning_failed',
  "provisioning_error" = 'normalized_email_collision'
FROM duplicate_ids d
WHERE d."id" = u."id";

CREATE UNIQUE INDEX IF NOT EXISTS "users_normalized_email_unique"
  ON "users" ("normalized_email")
  WHERE "normalized_email" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "clerk_webhook_events" (
  "id" text PRIMARY KEY,
  "event_type" text NOT NULL,
  "clerk_user_id" text,
  "processed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "status" text NOT NULL DEFAULT 'processed',
  "error" text
);
