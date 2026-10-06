CREATE TABLE IF NOT EXISTS "general_queue_cash_sessions" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "location_id" integer NOT NULL REFERENCES "inventory_locations"("id"),
  "register_box_id" integer NOT NULL REFERENCES "csr_boxes"("id"),
  "status" text NOT NULL DEFAULT 'open',
  "opened_by_user_id" integer NOT NULL REFERENCES "users"("id"),
  "opened_at" timestamptz NOT NULL DEFAULT now(),
  "opening_balance" numeric(10,2) NOT NULL DEFAULT 0,
  "closed_by_user_id" integer REFERENCES "users"("id"),
  "closed_at" timestamptz,
  "closing_balance" numeric(10,2),
  "expected_balance" numeric(10,2),
  "difference_amount" numeric(10,2),
  "payment_totals_json" json DEFAULT '{}'::json,
  "summary" json DEFAULT '{}'::json,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "general_queue_cash_sessions_status_check" CHECK ("status" IN ('open', 'closed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "general_queue_cash_sessions_open_register_uq"
  ON "general_queue_cash_sessions" ("tenant_id", "location_id", "register_box_id")
  WHERE "status" = 'open';

CREATE TABLE IF NOT EXISTS "general_queue_cash_session_participants" (
  "session_id" integer NOT NULL REFERENCES "general_queue_cash_sessions"("id"),
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  "joined_by_user_id" integer NOT NULL REFERENCES "users"("id"),
  "left_at" timestamptz,
  PRIMARY KEY ("session_id", "user_id")
);

ALTER TABLE "cash_ledger_entries"
  ADD COLUMN IF NOT EXISTS "general_queue_session_id" integer REFERENCES "general_queue_cash_sessions"("id"),
  ADD COLUMN IF NOT EXISTS "actor_user_id" integer REFERENCES "users"("id"),
  ADD COLUMN IF NOT EXISTS "location_id" integer REFERENCES "inventory_locations"("id"),
  ADD COLUMN IF NOT EXISTS "amount_tendered" numeric(10,2),
  ADD COLUMN IF NOT EXISTS "change_given" numeric(10,2),
  ADD COLUMN IF NOT EXISTS "internal_note" text;

UPDATE "cash_ledger_entries"
SET "actor_user_id" = "csr_user_id",
    "amount_tendered" = "amount",
    "change_given" = 0
WHERE "actor_user_id" IS NULL;

ALTER TABLE "cash_ledger_entries"
  ALTER COLUMN "actor_user_id" SET NOT NULL,
  ALTER COLUMN "amount_tendered" SET NOT NULL,
  ALTER COLUMN "change_given" SET NOT NULL;

ALTER TABLE "cash_ledger_entries" DROP CONSTRAINT IF EXISTS "cash_ledger_accountability_context_check";
ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_accountability_context_check"
  CHECK (("shift_id" IS NOT NULL)::integer + ("general_queue_session_id" IS NOT NULL)::integer = 1);

CREATE INDEX IF NOT EXISTS "cash_ledger_general_queue_session_idx"
  ON "cash_ledger_entries" ("general_queue_session_id", "created_at");
