CREATE TABLE IF NOT EXISTS "cash_ledger_entries" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "order_id" integer NOT NULL REFERENCES "orders"("id"),
  "shift_id" integer,
  "csr_user_id" integer NOT NULL REFERENCES "users"("id"),
  "box_assignment_id" text NOT NULL,
  "amount" numeric(10, 2) NOT NULL,
  "entry_type" text NOT NULL DEFAULT 'cash_sale_closeout',
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "cash_ledger_entries_idempotency_key_idx"
  ON "cash_ledger_entries" ("idempotency_key");

CREATE UNIQUE INDEX IF NOT EXISTS "cash_ledger_entries_order_cash_closeout_idx"
  ON "cash_ledger_entries" ("order_id", "entry_type")
  WHERE "entry_type" = 'cash_sale_closeout';
