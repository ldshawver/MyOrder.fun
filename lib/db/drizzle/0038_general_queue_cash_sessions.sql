-- General Queue cash accountability.
-- Forward-only: preserve session and ledger history; never silently repair
-- cross-tenant accounting relationships.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "users" GROUP BY "tenant_id", "id" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce users tenant identity: duplicate (tenant_id, id) rows exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "inventory_locations" GROUP BY "tenant_id", "id" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce inventory location tenant identity: duplicate (tenant_id, id) rows exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "csr_boxes" GROUP BY "tenant_id", "id" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce CSR box tenant identity: duplicate (tenant_id, id) rows exist';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_tenant_id_id_unique' AND conrelid = 'users'::regclass) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_locations_tenant_id_id_unique' AND conrelid = 'inventory_locations'::regclass) THEN
    ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_tenant_id_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'csr_boxes_tenant_id_id_unique' AND conrelid = 'csr_boxes'::regclass) THEN
    ALTER TABLE "csr_boxes" ADD CONSTRAINT "csr_boxes_tenant_id_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
END $$;

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'general_queue_cash_sessions_status_check'
      AND conrelid = 'general_queue_cash_sessions'::regclass
  ) THEN
    ALTER TABLE "general_queue_cash_sessions"
      ADD CONSTRAINT "general_queue_cash_sessions_status_check"
      CHECK ("status" IN ('open', 'closed'));
  END IF;
  IF EXISTS (
    SELECT 1 FROM "general_queue_cash_sessions"
    GROUP BY "tenant_id", "id" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce General Queue session tenant identity: duplicate (tenant_id, id) rows exist';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'general_queue_cash_sessions_tenant_id_id_unique'
      AND conrelid = 'general_queue_cash_sessions'::regclass
  ) THEN
    ALTER TABLE "general_queue_cash_sessions"
      ADD CONSTRAINT "general_queue_cash_sessions_tenant_id_id_unique"
      UNIQUE ("tenant_id", "id");
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "general_queue_cash_sessions" s
    JOIN "inventory_locations" l ON l."id" = s."location_id"
    WHERE l."tenant_id" IS DISTINCT FROM s."tenant_id"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce session/location tenant consistency: cross-tenant rows exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "general_queue_cash_sessions" s
    JOIN "csr_boxes" b ON b."id" = s."register_box_id"
    WHERE b."tenant_id" IS DISTINCT FROM s."tenant_id"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce session/register tenant consistency: cross-tenant rows exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "general_queue_cash_sessions" s
    JOIN "users" u ON u."id" = s."opened_by_user_id"
    WHERE u."tenant_id" IS NULL OR u."tenant_id" IS DISTINCT FROM s."tenant_id"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce session/opening-user tenant consistency: null or cross-tenant users exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "general_queue_cash_sessions" s
    JOIN "users" u ON u."id" = s."closed_by_user_id"
    WHERE u."tenant_id" IS NULL OR u."tenant_id" IS DISTINCT FROM s."tenant_id"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce session/closing-user tenant consistency: null or cross-tenant users exist';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gq_sessions_tenant_location_fk' AND conrelid = 'general_queue_cash_sessions'::regclass) THEN
    ALTER TABLE "general_queue_cash_sessions"
      ADD CONSTRAINT "gq_sessions_tenant_location_fk"
      FOREIGN KEY ("tenant_id", "location_id")
      REFERENCES "inventory_locations" ("tenant_id", "id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gq_sessions_tenant_register_box_fk' AND conrelid = 'general_queue_cash_sessions'::regclass) THEN
    ALTER TABLE "general_queue_cash_sessions"
      ADD CONSTRAINT "gq_sessions_tenant_register_box_fk"
      FOREIGN KEY ("tenant_id", "register_box_id")
      REFERENCES "csr_boxes" ("tenant_id", "id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gq_sessions_tenant_opened_by_user_fk' AND conrelid = 'general_queue_cash_sessions'::regclass) THEN
    ALTER TABLE "general_queue_cash_sessions"
      ADD CONSTRAINT "gq_sessions_tenant_opened_by_user_fk"
      FOREIGN KEY ("tenant_id", "opened_by_user_id")
      REFERENCES "users" ("tenant_id", "id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gq_sessions_tenant_closed_by_user_fk' AND conrelid = 'general_queue_cash_sessions'::regclass) THEN
    ALTER TABLE "general_queue_cash_sessions"
      ADD CONSTRAINT "gq_sessions_tenant_closed_by_user_fk"
      FOREIGN KEY ("tenant_id", "closed_by_user_id")
      REFERENCES "users" ("tenant_id", "id") MATCH SIMPLE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "general_queue_cash_session_participants" (
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "session_id" integer NOT NULL REFERENCES "general_queue_cash_sessions"("id"),
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  "joined_by_user_id" integer NOT NULL REFERENCES "users"("id"),
  "left_at" timestamptz,
  PRIMARY KEY ("session_id", "user_id")
);

ALTER TABLE "general_queue_cash_session_participants"
  ADD COLUMN IF NOT EXISTS "tenant_id" integer REFERENCES "tenants"("id");

UPDATE "general_queue_cash_session_participants" p
SET "tenant_id" = s."tenant_id"
FROM "general_queue_cash_sessions" s
WHERE p."session_id" = s."id"
  AND p."tenant_id" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "general_queue_cash_session_participants" p
    LEFT JOIN "general_queue_cash_sessions" s ON s."id" = p."session_id"
    WHERE p."tenant_id" IS NULL
       OR s."id" IS NULL
       OR p."tenant_id" IS DISTINCT FROM s."tenant_id"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce participant/session tenant consistency: null, orphan, or conflicting rows exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "general_queue_cash_session_participants" p
    JOIN "users" u ON u."id" = p."user_id"
    WHERE u."tenant_id" IS NULL OR u."tenant_id" IS DISTINCT FROM p."tenant_id"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce participant/user tenant consistency: null or cross-tenant users exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "general_queue_cash_session_participants" p
    JOIN "users" u ON u."id" = p."joined_by_user_id"
    WHERE u."tenant_id" IS NULL OR u."tenant_id" IS DISTINCT FROM p."tenant_id"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce participant/joining-user tenant consistency: null or cross-tenant users exist';
  END IF;
END $$;

ALTER TABLE "general_queue_cash_session_participants"
  ALTER COLUMN "tenant_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gq_participants_tenant_session_fk' AND conrelid = 'general_queue_cash_session_participants'::regclass) THEN
    ALTER TABLE "general_queue_cash_session_participants"
      ADD CONSTRAINT "gq_participants_tenant_session_fk"
      FOREIGN KEY ("tenant_id", "session_id")
      REFERENCES "general_queue_cash_sessions" ("tenant_id", "id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gq_participants_tenant_user_fk' AND conrelid = 'general_queue_cash_session_participants'::regclass) THEN
    ALTER TABLE "general_queue_cash_session_participants"
      ADD CONSTRAINT "gq_participants_tenant_user_fk"
      FOREIGN KEY ("tenant_id", "user_id")
      REFERENCES "users" ("tenant_id", "id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gq_participants_tenant_joined_by_user_fk' AND conrelid = 'general_queue_cash_session_participants'::regclass) THEN
    ALTER TABLE "general_queue_cash_session_participants"
      ADD CONSTRAINT "gq_participants_tenant_joined_by_user_fk"
      FOREIGN KEY ("tenant_id", "joined_by_user_id")
      REFERENCES "users" ("tenant_id", "id") MATCH SIMPLE;
  END IF;
END $$;

ALTER TABLE "cash_ledger_entries"
  ADD COLUMN IF NOT EXISTS "general_queue_session_id" integer REFERENCES "general_queue_cash_sessions"("id"),
  ADD COLUMN IF NOT EXISTS "actor_user_id" integer REFERENCES "users"("id"),
  ADD COLUMN IF NOT EXISTS "location_id" integer REFERENCES "inventory_locations"("id"),
  ADD COLUMN IF NOT EXISTS "amount_tendered" numeric(10,2),
  ADD COLUMN IF NOT EXISTS "change_given" numeric(10,2),
  ADD COLUMN IF NOT EXISTS "internal_note" text;

UPDATE "cash_ledger_entries"
SET "actor_user_id" = COALESCE("actor_user_id", "csr_user_id"),
    "amount_tendered" = COALESCE("amount_tendered", "amount"),
    "change_given" = COALESCE("change_given", 0)
WHERE "actor_user_id" IS NULL
   OR "amount_tendered" IS NULL
   OR "change_given" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "cash_ledger_entries"
    WHERE "actor_user_id" IS NULL OR "amount_tendered" IS NULL OR "change_given" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot enforce cash ledger required fields: backfill left null values';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "cash_ledger_entries" e
    JOIN "general_queue_cash_sessions" s ON s."id" = e."general_queue_session_id"
    WHERE s."tenant_id" IS DISTINCT FROM e."tenant_id"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce ledger/session tenant consistency: cross-tenant rows exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "cash_ledger_entries" e
    JOIN "users" u ON u."id" = e."actor_user_id"
    WHERE u."tenant_id" IS NULL OR u."tenant_id" IS DISTINCT FROM e."tenant_id"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce ledger/actor tenant consistency: null or cross-tenant users exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "cash_ledger_entries" e
    JOIN "inventory_locations" l ON l."id" = e."location_id"
    WHERE l."tenant_id" IS DISTINCT FROM e."tenant_id"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce ledger/location tenant consistency: cross-tenant rows exist';
  END IF;
END $$;

ALTER TABLE "cash_ledger_entries"
  ALTER COLUMN "actor_user_id" SET NOT NULL,
  ALTER COLUMN "amount_tendered" SET NOT NULL,
  ALTER COLUMN "change_given" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_ledger_tenant_gq_session_fk' AND conrelid = 'cash_ledger_entries'::regclass) THEN
    ALTER TABLE "cash_ledger_entries"
      ADD CONSTRAINT "cash_ledger_tenant_gq_session_fk"
      FOREIGN KEY ("tenant_id", "general_queue_session_id")
      REFERENCES "general_queue_cash_sessions" ("tenant_id", "id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_ledger_tenant_actor_user_fk' AND conrelid = 'cash_ledger_entries'::regclass) THEN
    ALTER TABLE "cash_ledger_entries"
      ADD CONSTRAINT "cash_ledger_tenant_actor_user_fk"
      FOREIGN KEY ("tenant_id", "actor_user_id")
      REFERENCES "users" ("tenant_id", "id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_ledger_tenant_location_fk' AND conrelid = 'cash_ledger_entries'::regclass) THEN
    ALTER TABLE "cash_ledger_entries"
      ADD CONSTRAINT "cash_ledger_tenant_location_fk"
      FOREIGN KEY ("tenant_id", "location_id")
      REFERENCES "inventory_locations" ("tenant_id", "id") MATCH SIMPLE;
  END IF;
END $$;

ALTER TABLE "cash_ledger_entries"
  DROP CONSTRAINT IF EXISTS "cash_ledger_accountability_context_check";
ALTER TABLE "cash_ledger_entries"
  ADD CONSTRAINT "cash_ledger_accountability_context_check"
  CHECK (("shift_id" IS NOT NULL)::integer + ("general_queue_session_id" IS NOT NULL)::integer = 1);

CREATE INDEX IF NOT EXISTS "cash_ledger_general_queue_session_idx"
  ON "cash_ledger_entries" ("general_queue_session_id", "created_at");
