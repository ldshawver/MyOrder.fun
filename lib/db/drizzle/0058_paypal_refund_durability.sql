-- A refund intent must be durable before the PayPal POST.  The request ID is
-- intentionally separate from the local HTTP/return idempotency key.
ALTER TABLE "payment_refunds"
  ADD COLUMN "provider_request_id" text,
  ADD COLUMN "provider_status" text,
  ADD COLUMN "provider_result_at" timestamptz,
  ADD COLUMN "requested_at" timestamptz,
  ADD COLUMN "locally_finalized_at" timestamptz;

-- Historical rows did not retain their PayPal request identity.  Mark them as
-- legacy/reconciliation rows rather than inventing an identifier.
UPDATE "payment_refunds"
  SET "state" = CASE WHEN "state" = 'completed' THEN 'locally_finalized' ELSE "state" END,
      "requested_at" = COALESCE("requested_at", "created_at")
  WHERE "state" <> 'reconciliation_required';
UPDATE "payment_refunds"
  SET "requested_at" = COALESCE("requested_at", "created_at")
  WHERE "requested_at" IS NULL;

ALTER TABLE "payment_refunds" DROP CONSTRAINT IF EXISTS "payment_refunds_state_check";
ALTER TABLE "payment_refunds"
  ADD CONSTRAINT "payment_refunds_state_check"
  CHECK ("state" IN ('requested','provider_succeeded','locally_finalized','pending','failed','reconciliation_required'));
ALTER TABLE "payment_refunds"
  ALTER COLUMN "provider_request_id" DROP NOT NULL;
ALTER TABLE "payment_refunds"
  ADD CONSTRAINT "payment_refunds_provider_request_unique" UNIQUE ("provider_request_id");

ALTER TABLE "payment_webhook_events"
  ADD COLUMN "provider_refund_id" text,
  ADD COLUMN "payment_refund_id" integer;
ALTER TABLE "payment_webhook_events"
  ADD CONSTRAINT "payment_webhook_tenant_refund_fk"
  FOREIGN KEY ("tenant_id", "payment_refund_id") REFERENCES "payment_refunds"("tenant_id", "id");
