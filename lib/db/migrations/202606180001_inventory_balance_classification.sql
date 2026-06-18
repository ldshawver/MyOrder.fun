ALTER TABLE "inventory_balances"
  ADD COLUMN IF NOT EXISTS "inventory_kind" text NOT NULL DEFAULT 'sellable',
  ADD COLUMN IF NOT EXISTS "is_sellable" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "quarantined_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "quarantined_by_user_id" integer REFERENCES "users"("id"),
  ADD COLUMN IF NOT EXISTS "quarantine_reason" text;
