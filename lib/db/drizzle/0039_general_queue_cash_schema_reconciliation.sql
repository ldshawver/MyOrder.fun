-- Forward-only reconciliation for General Queue cash sessions.
-- 0038 is immutable: this migration upgrades databases that applied its
-- original shape without rewriting historical cash accountability records.

ALTER TABLE "general_queue_cash_sessions"
  ALTER COLUMN "register_box_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "open_idempotency_key" text,
  ADD COLUMN IF NOT EXISTS "close_idempotency_key" text,
  ADD COLUMN IF NOT EXISTS "discrepancy_reason" text;

ALTER TABLE "admin_settings"
  ADD COLUMN IF NOT EXISTS "cash_discrepancy_reason_threshold" numeric(10,2) NOT NULL DEFAULT 0;

ALTER TABLE "general_queue_cash_session_participants"
  ADD COLUMN IF NOT EXISTS "tenant_id" integer;

UPDATE "general_queue_cash_session_participants" p
SET "tenant_id" = s."tenant_id"
FROM "general_queue_cash_sessions" s
WHERE s."id" = p."session_id" AND p."tenant_id" IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "general_queue_cash_session_participants" p
    LEFT JOIN "general_queue_cash_sessions" s ON s."id" = p."session_id"
    WHERE s."id" IS NULL OR p."tenant_id" IS NULL OR p."tenant_id" IS DISTINCT FROM s."tenant_id"
  ) THEN
    RAISE EXCEPTION '0039 cannot reconcile participant tenant ownership: orphaned or conflicting rows exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "users" GROUP BY "tenant_id", "id" HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM "inventory_locations" GROUP BY "tenant_id", "id" HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM "csr_boxes" GROUP BY "tenant_id", "id" HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM "general_queue_cash_sessions" GROUP BY "tenant_id", "id" HAVING count(*) > 1)
  THEN
    RAISE EXCEPTION '0039 cannot create tenant identity constraints: duplicate composite identities exist';
  END IF;
END $$;

ALTER TABLE "general_queue_cash_session_participants" ALTER COLUMN "tenant_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='users'::regclass AND conname='users_tenant_id_id_unique') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='inventory_locations'::regclass AND conname='inventory_locations_tenant_id_id_unique') THEN
    ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_tenant_id_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='csr_boxes'::regclass AND conname='csr_boxes_tenant_id_id_unique') THEN
    ALTER TABLE "csr_boxes" ADD CONSTRAINT "csr_boxes_tenant_id_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='general_queue_cash_sessions'::regclass AND conname='general_queue_cash_sessions_tenant_id_id_unique') THEN
    ALTER TABLE "general_queue_cash_sessions" ADD CONSTRAINT "general_queue_cash_sessions_tenant_id_id_unique" UNIQUE ("tenant_id", "id");
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "general_queue_cash_sessions" s JOIN "inventory_locations" l ON l.id=s.location_id WHERE l.tenant_id IS DISTINCT FROM s.tenant_id) THEN
    RAISE EXCEPTION '0039 cannot enforce session/location tenant ownership: conflicting rows exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "general_queue_cash_sessions" s JOIN "csr_boxes" b ON b.id=s.register_box_id WHERE s.register_box_id IS NOT NULL AND b.tenant_id IS DISTINCT FROM s.tenant_id) THEN
    RAISE EXCEPTION '0039 cannot enforce session/register tenant ownership: conflicting rows exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "general_queue_cash_sessions" s JOIN "users" u ON u.id=s.opened_by_user_id WHERE u.tenant_id IS DISTINCT FROM s.tenant_id) THEN
    RAISE EXCEPTION '0039 cannot enforce session opener tenant ownership: conflicting rows exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "general_queue_cash_sessions" s JOIN "users" u ON u.id=s.closed_by_user_id WHERE s.closed_by_user_id IS NOT NULL AND u.tenant_id IS DISTINCT FROM s.tenant_id) THEN
    RAISE EXCEPTION '0039 cannot enforce session closer tenant ownership: conflicting rows exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "general_queue_cash_sessions" WHERE status='open' GROUP BY tenant_id,location_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0039 cannot enforce one open session per tenant/location: conflicting open sessions exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "general_queue_cash_session_participants" p JOIN "users" u ON u.id=p.user_id WHERE u.tenant_id IS DISTINCT FROM p.tenant_id)
    OR EXISTS (SELECT 1 FROM "general_queue_cash_session_participants" p JOIN "users" u ON u.id=p.joined_by_user_id WHERE u.tenant_id IS DISTINCT FROM p.tenant_id)
  THEN RAISE EXCEPTION '0039 cannot enforce participant user tenant ownership: conflicting rows exist';
  END IF;
  IF EXISTS (SELECT 1 FROM "cash_ledger_entries" e JOIN "general_queue_cash_sessions" s ON s.id=e.general_queue_session_id WHERE e.general_queue_session_id IS NOT NULL AND s.tenant_id IS DISTINCT FROM e.tenant_id)
    OR EXISTS (SELECT 1 FROM "cash_ledger_entries" e JOIN "users" u ON u.id=e.actor_user_id WHERE u.tenant_id IS DISTINCT FROM e.tenant_id)
    OR EXISTS (SELECT 1 FROM "cash_ledger_entries" e JOIN "inventory_locations" l ON l.id=e.location_id WHERE e.location_id IS NOT NULL AND l.tenant_id IS DISTINCT FROM e.tenant_id)
  THEN RAISE EXCEPTION '0039 cannot enforce cash ledger tenant ownership: conflicting rows exist';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='general_queue_cash_sessions'::regclass AND conname='gq_sessions_tenant_location_fk') THEN
    ALTER TABLE "general_queue_cash_sessions" ADD CONSTRAINT "gq_sessions_tenant_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "inventory_locations"("tenant_id","id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='general_queue_cash_sessions'::regclass AND conname='gq_sessions_tenant_register_box_fk') THEN
    ALTER TABLE "general_queue_cash_sessions" ADD CONSTRAINT "gq_sessions_tenant_register_box_fk" FOREIGN KEY ("tenant_id","register_box_id") REFERENCES "csr_boxes"("tenant_id","id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='general_queue_cash_sessions'::regclass AND conname='gq_sessions_tenant_opened_by_user_fk') THEN
    ALTER TABLE "general_queue_cash_sessions" ADD CONSTRAINT "gq_sessions_tenant_opened_by_user_fk" FOREIGN KEY ("tenant_id","opened_by_user_id") REFERENCES "users"("tenant_id","id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='general_queue_cash_sessions'::regclass AND conname='gq_sessions_tenant_closed_by_user_fk') THEN
    ALTER TABLE "general_queue_cash_sessions" ADD CONSTRAINT "gq_sessions_tenant_closed_by_user_fk" FOREIGN KEY ("tenant_id","closed_by_user_id") REFERENCES "users"("tenant_id","id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='general_queue_cash_session_participants'::regclass AND conname='gq_participants_tenant_session_fk') THEN
    ALTER TABLE "general_queue_cash_session_participants" ADD CONSTRAINT "gq_participants_tenant_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "general_queue_cash_sessions"("tenant_id","id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='general_queue_cash_session_participants'::regclass AND conname='gq_participants_tenant_user_fk') THEN
    ALTER TABLE "general_queue_cash_session_participants" ADD CONSTRAINT "gq_participants_tenant_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "users"("tenant_id","id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='general_queue_cash_session_participants'::regclass AND conname='gq_participants_tenant_joined_by_user_fk') THEN
    ALTER TABLE "general_queue_cash_session_participants" ADD CONSTRAINT "gq_participants_tenant_joined_by_user_fk" FOREIGN KEY ("tenant_id","joined_by_user_id") REFERENCES "users"("tenant_id","id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cash_ledger_entries'::regclass AND conname='cash_ledger_tenant_gq_session_fk') THEN
    ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_tenant_gq_session_fk" FOREIGN KEY ("tenant_id","general_queue_session_id") REFERENCES "general_queue_cash_sessions"("tenant_id","id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cash_ledger_entries'::regclass AND conname='cash_ledger_tenant_actor_user_fk') THEN
    ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_tenant_actor_user_fk" FOREIGN KEY ("tenant_id","actor_user_id") REFERENCES "users"("tenant_id","id") MATCH SIMPLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='cash_ledger_entries'::regclass AND conname='cash_ledger_tenant_location_fk') THEN
    ALTER TABLE "cash_ledger_entries" ADD CONSTRAINT "cash_ledger_tenant_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "inventory_locations"("tenant_id","id") MATCH SIMPLE;
  END IF;
END $$;

DROP INDEX IF EXISTS "general_queue_cash_sessions_open_register_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "general_queue_cash_sessions_open_location_uq"
  ON "general_queue_cash_sessions" ("tenant_id", "location_id") WHERE "status"='open';
CREATE UNIQUE INDEX IF NOT EXISTS "general_queue_cash_sessions_open_idempotency_uq"
  ON "general_queue_cash_sessions" ("tenant_id", "open_idempotency_key") WHERE "open_idempotency_key" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "general_queue_cash_sessions_close_idempotency_uq"
  ON "general_queue_cash_sessions" ("tenant_id", "close_idempotency_key") WHERE "close_idempotency_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "gq_participants_tenant_session_active_idx"
  ON "general_queue_cash_session_participants" ("tenant_id", "session_id") WHERE "left_at" IS NULL;
