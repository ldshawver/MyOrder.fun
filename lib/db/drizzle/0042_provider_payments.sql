-- Provider-neutral, tenant-scoped online payment ledger.
-- Stores only identifiers, monetary facts, state, and sanitized failure classes.

CREATE TABLE "payment_attempts" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "order_id" integer NOT NULL,
  "provider" text NOT NULL,
  "provider_environment" text NOT NULL,
  "provider_order_id" text,
  "idempotency_key" text NOT NULL,
  "requested_amount" numeric(12,2) NOT NULL,
  "requested_currency" text NOT NULL,
  "captured_amount" numeric(12,2),
  "captured_currency" text,
  "state" text NOT NULL DEFAULT 'creating',
  "reconciliation_state" text NOT NULL DEFAULT 'not_required',
  "failure_class" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "id"),
  UNIQUE ("tenant_id", "order_id", "idempotency_key"),
  UNIQUE ("provider", "provider_environment", "provider_order_id"),
  FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id"),
  CHECK ("provider" = 'paypal'),
  CHECK ("provider_environment" IN ('sandbox','live')),
  CHECK ("requested_amount" > 0),
  CHECK ("requested_currency" ~ '^[A-Z]{3}$'),
  CHECK ("captured_amount" IS NULL OR "captured_amount" >= 0),
  CHECK ("captured_currency" IS NULL OR "captured_currency" ~ '^[A-Z]{3}$'),
  CHECK ("state" IN ('creating','created','approved','capturing','captured','failed','cancelled','refunded','partially_refunded','reconciliation_required')),
  CHECK ("reconciliation_state" IN ('not_required','pending','resolved','manual_review'))
);

CREATE INDEX "payment_attempts_order_idx" ON "payment_attempts" ("tenant_id", "order_id", "created_at");

CREATE TABLE "payment_captures" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "payment_attempt_id" integer NOT NULL,
  "provider" text NOT NULL,
  "provider_environment" text NOT NULL,
  "provider_capture_id" text NOT NULL,
  "amount" numeric(12,2) NOT NULL,
  "currency" text NOT NULL,
  "state" text NOT NULL,
  "captured_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "id"),
  UNIQUE ("provider", "provider_environment", "provider_capture_id"),
  FOREIGN KEY ("tenant_id", "payment_attempt_id") REFERENCES "payment_attempts"("tenant_id", "id"),
  CHECK ("provider" = 'paypal'),
  CHECK ("provider_environment" IN ('sandbox','live')),
  CHECK ("amount" > 0),
  CHECK ("currency" ~ '^[A-Z]{3}$'),
  CHECK ("state" IN ('completed','pending','declined','refunded','partially_refunded','reconciliation_required'))
);

CREATE TABLE "payment_refunds" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "payment_capture_id" integer NOT NULL,
  "provider_refund_id" text,
  "idempotency_key" text NOT NULL,
  "amount" numeric(12,2) NOT NULL,
  "currency" text NOT NULL,
  "reason" text NOT NULL,
  "state" text NOT NULL DEFAULT 'creating',
  "failure_class" text,
  "actor_user_id" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "id"),
  UNIQUE ("tenant_id", "payment_capture_id", "idempotency_key"),
  UNIQUE ("provider_refund_id"),
  FOREIGN KEY ("tenant_id", "payment_capture_id") REFERENCES "payment_captures"("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES "users"("tenant_id", "id"),
  CHECK ("amount" > 0),
  CHECK ("currency" ~ '^[A-Z]{3}$'),
  CHECK ("state" IN ('creating','completed','pending','failed','reconciliation_required'))
);

CREATE TABLE "payment_webhook_events" (
  "id" serial PRIMARY KEY,
  "provider" text NOT NULL,
  "provider_environment" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "provider_order_id" text,
  "provider_capture_id" text,
  "tenant_id" integer REFERENCES "tenants"("id"),
  "payment_attempt_id" integer,
  "processing_state" text NOT NULL DEFAULT 'received',
  "failure_class" text,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  UNIQUE ("provider", "provider_environment", "provider_event_id"),
  FOREIGN KEY ("tenant_id", "payment_attempt_id") REFERENCES "payment_attempts"("tenant_id", "id"),
  CHECK ("provider" = 'paypal'),
  CHECK ("provider_environment" IN ('sandbox','live')),
  CHECK ("processing_state" IN ('received','verified','processed','ignored','failed','reconciliation_required'))
);

CREATE INDEX "payment_webhook_lookup_idx" ON "payment_webhook_events" ("provider", "provider_environment", "provider_order_id", "provider_capture_id");

-- PayPal is the intended online provider. Preserve mixed/manual configurations;
-- only replace the untouched historical Stripe-only default.
ALTER TABLE "admin_settings" ALTER COLUMN "enabled_processors" SET DEFAULT ARRAY['paypal']::text[];
UPDATE "admin_settings" SET "enabled_processors" = ARRAY['paypal']::text[] WHERE "enabled_processors" = ARRAY['stripe']::text[];
