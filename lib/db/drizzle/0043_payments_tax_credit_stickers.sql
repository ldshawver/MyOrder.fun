-- Forward-only payment, sales-tax, Customer Credit, and Thank You sticker foundation.
-- Historical Stripe identifiers/rows remain untouched. New financial facts are additive.

ALTER TABLE "catalog_items"
  ADD COLUMN IF NOT EXISTS "is_taxable" boolean NOT NULL DEFAULT true;

CREATE TABLE "tax_configurations" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "location_id" integer NOT NULL,
  "jurisdiction" text NOT NULL,
  "rate" numeric(9,8) NOT NULL,
  "sourcing_rule" text NOT NULL,
  "effective_from" date NOT NULL,
  "effective_until" date,
  "source_name" text NOT NULL,
  "source_url" text NOT NULL,
  "verified_at" timestamptz NOT NULL,
  "verified_by_user_id" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "location_id") REFERENCES "inventory_locations"("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "verified_by_user_id") REFERENCES "users"("tenant_id", "id"),
  CHECK (length(trim("jurisdiction")) > 0),
  CHECK ("rate" >= 0 AND "rate" <= 1),
  CHECK ("sourcing_rule" IN ('origin','destination','pickup')),
  CHECK ("effective_until" IS NULL OR "effective_until" >= "effective_from")
);
CREATE INDEX "tax_configurations_effective_idx"
  ON "tax_configurations" ("tenant_id", "location_id", "effective_from", "effective_until");

ALTER TABLE "order_tax_snapshots"
  ADD COLUMN IF NOT EXISTS "location_id" integer,
  ADD COLUMN IF NOT EXISTS "tax_configuration_id" integer,
  ADD COLUMN IF NOT EXISTS "gross_sales" numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tax_calculated" numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tax_refunded" numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rounding_policy" text NOT NULL DEFAULT 'round_half_away_from_zero_per_order';

CREATE TABLE "customer_credit_accounts" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "customer_id" integer NOT NULL,
  "balance" numeric(12,2) NOT NULL DEFAULT 0,
  "reserved_balance" numeric(12,2) NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "id"),
  UNIQUE ("tenant_id", "customer_id"),
  FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "users"("tenant_id", "id"),
  CHECK ("balance" >= 0),
  CHECK ("reserved_balance" >= 0),
  CHECK ("reserved_balance" <= "balance")
);

CREATE TABLE "customer_credit_ledger" (
  "id" bigserial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "account_id" integer NOT NULL,
  "customer_id" integer NOT NULL,
  "entry_type" text NOT NULL,
  "amount" numeric(12,2) NOT NULL,
  "reason" text NOT NULL,
  "actor_user_id" integer NOT NULL,
  "order_id" integer,
  "payment_attempt_id" integer,
  "payment_refund_id" integer,
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "id"),
  UNIQUE ("tenant_id", "idempotency_key"),
  FOREIGN KEY ("tenant_id", "account_id") REFERENCES "customer_credit_accounts"("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "users"("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "payment_attempt_id") REFERENCES "payment_attempts"("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "payment_refund_id") REFERENCES "payment_refunds"("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES "users"("tenant_id", "id"),
  CHECK ("amount" <> 0),
  CHECK ("entry_type" IN ('issued','administrative_adjustment','order_reservation','payment_consumption','reservation_release','refund_restoration')),
  CHECK (length(trim("reason")) > 0),
  CHECK (length(trim("idempotency_key")) > 0)
);
CREATE INDEX "customer_credit_ledger_account_idx"
  ON "customer_credit_ledger" ("tenant_id", "account_id", "created_at", "id");
CREATE INDEX "customer_credit_ledger_order_idx"
  ON "customer_credit_ledger" ("tenant_id", "order_id", "created_at", "id");

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "gross_subtotal" numeric(12,2),
  ADD COLUMN IF NOT EXISTS "discount_total" numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "taxable_subtotal" numeric(12,2),
  ADD COLUMN IF NOT EXISTS "non_taxable_subtotal" numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "customer_credit_applied" numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "remaining_tender_amount" numeric(12,2),
  ADD COLUMN IF NOT EXISTS "amount_tendered" numeric(12,2),
  ADD COLUMN IF NOT EXISTS "change_given" numeric(12,2),
  ADD COLUMN IF NOT EXISTS "financial_finalized_at" timestamptz;

ALTER TABLE "payment_attempts"
  ADD COLUMN IF NOT EXISTS "funding_source" text;

CREATE TABLE "sales_tax_reporting_periods" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "location_id" integer,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "reconciliation_difference" numeric(12,2),
  "filed_amount" numeric(12,2),
  "confirmation_reference" text,
  "reviewed_by_user_id" integer,
  "reviewed_at" timestamptz,
  "filed_by_user_id" integer,
  "filed_at" timestamptz,
  "paid_by_user_id" integer,
  "paid_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "id"),
  UNIQUE ("tenant_id", "location_id", "period_start", "period_end"),
  FOREIGN KEY ("tenant_id", "location_id") REFERENCES "inventory_locations"("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "reviewed_by_user_id") REFERENCES "users"("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "filed_by_user_id") REFERENCES "users"("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "paid_by_user_id") REFERENCES "users"("tenant_id", "id"),
  CHECK ("period_end" >= "period_start"),
  CHECK ("status" IN ('open','reviewed','filed','paid')),
  CHECK ("status" NOT IN ('filed','paid') OR ("confirmation_reference" IS NOT NULL AND length(trim("confirmation_reference")) > 0))
);

ALTER TABLE "print_jobs"
  ADD COLUMN IF NOT EXISTS "artwork_checksum" text;

-- Active processor defaults become PayPal-only. Historical order/payment data is preserved.
ALTER TABLE "admin_settings" ALTER COLUMN "enabled_processors" SET DEFAULT ARRAY['paypal']::text[];
UPDATE "admin_settings" SET "enabled_processors" = ARRAY['paypal']::text[];
