-- Reconcile staging's already-applied historical 0058 constraint with the
-- canonical refund states. Keep the historical migration and ledger intact.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "payment_refunds"
    WHERE "state" NOT IN (
      'requested', 'provider_succeeded', 'locally_finalized', 'completed',
      'pending', 'failed', 'reconciliation_required'
    )
  ) THEN
    RAISE EXCEPTION 'payment_refunds contains an unexpected state; refusing constraint reconciliation';
  END IF;

  ALTER TABLE "payment_refunds" DROP CONSTRAINT IF EXISTS "payment_refunds_state_check";
  ALTER TABLE "payment_refunds"
    ADD CONSTRAINT "payment_refunds_state_check"
    CHECK ("state" IN (
      'requested', 'provider_succeeded', 'locally_finalized', 'completed',
      'pending', 'failed', 'reconciliation_required'
    ));
END $$;
