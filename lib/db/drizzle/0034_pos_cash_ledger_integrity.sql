-- Canonical cash closeout ledger with database-enforced idempotency.
CREATE TABLE IF NOT EXISTS "cash_ledger_entries" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "order_id" integer NOT NULL REFERENCES "orders"("id"),
  "shift_id" integer REFERENCES "lab_tech_shifts"("id") ON DELETE SET NULL,
  "csr_user_id" integer NOT NULL REFERENCES "users"("id"),
  "box_assignment_id" text NOT NULL,
  "amount" numeric(10, 2) NOT NULL,
  "entry_type" text NOT NULL DEFAULT 'cash_sale_closeout',
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "cash_ledger_entries" e
    LEFT JOIN "lab_tech_shifts" s ON s."id" = e."shift_id"
    WHERE e."shift_id" IS NOT NULL AND s."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add cash_ledger_entries.shift_id foreign key: orphan rows exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
     AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'cash_ledger_entries'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'lab_tech_shifts'::regclass
      AND array_length(c.conkey, 1) = 1
      AND a.attname = 'shift_id'
  ) THEN
    ALTER TABLE "cash_ledger_entries"
      ADD CONSTRAINT "cash_ledger_entries_shift_id_lab_tech_shifts_id_fk"
      FOREIGN KEY ("shift_id") REFERENCES "lab_tech_shifts"("id")
      ON DELETE SET NULL NOT VALID;
    ALTER TABLE "cash_ledger_entries"
      VALIDATE CONSTRAINT "cash_ledger_entries_shift_id_lab_tech_shifts_id_fk";
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "cash_ledger_entries_idempotency_key_idx"
  ON "cash_ledger_entries" ("idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "cash_ledger_entries_order_cash_closeout_idx"
  ON "cash_ledger_entries" ("order_id", "entry_type")
  WHERE "entry_type" = 'cash_sale_closeout';
CREATE INDEX IF NOT EXISTS "cash_ledger_entries_shift_idx"
  ON "cash_ledger_entries" ("shift_id");
