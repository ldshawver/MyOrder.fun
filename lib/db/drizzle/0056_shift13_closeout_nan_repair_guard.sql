-- The original closeout package and commission snapshot remain immutable except
-- for the single, audited Shift 13 NaN incident.  This does not create a
-- generic editor: the application must set a transaction-local repair token,
-- target tenant 1 / shift 13, preserve every identity field, and replace the
-- corrupt derived values with finite canonical decimals.

DROP TRIGGER IF EXISTS shift_closeout_packages_immutable ON shift_closeout_packages;
CREATE OR REPLACE FUNCTION reject_immutable_shift_closeout_package_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.shift_closeout_nan_repair', true) = 'SHIFT_CLOSEOUT_NAN_REPAIR:13'
    AND OLD.tenant_id = 1 AND OLD.shift_id = 13
    AND NEW.id = OLD.id AND NEW.tenant_id = OLD.tenant_id AND NEW.shift_id = OLD.shift_id
    AND NEW.location_id IS NOT DISTINCT FROM OLD.location_id
    AND NEW.supervisor_user_id = OLD.supervisor_user_id
    AND NEW.idempotency_key = OLD.idempotency_key
    AND NEW.source_max_updated_at = OLD.source_max_updated_at
    AND NEW.closed_at = OLD.closed_at
    AND jsonb_typeof(NEW.snapshot_json->'eligibleSalesBase') = 'number'
    AND jsonb_typeof(NEW.snapshot_json->'tipAmount') = 'number'
    AND jsonb_typeof(NEW.snapshot_json->'finalTip') = 'number'
    AND jsonb_typeof(NEW.snapshot_json->'differenceAmount') = 'number'
    AND jsonb_typeof(NEW.snapshot_json->'depositAmount') = 'number'
    AND jsonb_typeof(NEW.snapshot_json->'newCashBalance') = 'number'
    AND (NEW.snapshot_json->>'eligibleSalesBase') ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$'
    AND (NEW.snapshot_json->>'tipAmount') ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$'
    AND (NEW.snapshot_json->>'finalTip') ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$'
    AND (NEW.snapshot_json->>'differenceAmount') ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$'
    AND (NEW.snapshot_json->>'depositAmount') ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$'
    AND (NEW.snapshot_json->>'newCashBalance') ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$'
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'shift_closeout_packages is immutable' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER shift_closeout_packages_immutable
  BEFORE UPDATE OR DELETE ON shift_closeout_packages
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_shift_closeout_package_mutation();

DROP TRIGGER IF EXISTS commission_snapshots_immutable ON commission_snapshots;
CREATE OR REPLACE FUNCTION reject_immutable_commission_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.shift_closeout_nan_repair', true) = 'SHIFT_CLOSEOUT_NAN_REPAIR:13'
    AND OLD.tenant_id = 1 AND OLD.shift_id = 13
    AND NEW.id = OLD.id AND NEW.tenant_id = OLD.tenant_id AND NEW.shift_id = OLD.shift_id
    AND NEW.closeout_package_id = OLD.closeout_package_id AND NEW.csr_user_id = OLD.csr_user_id
    AND NEW.rule_snapshot = OLD.rule_snapshot AND NEW.created_at = OLD.created_at
    AND (OLD.qualifying_sales::text IN ('NaN', 'Infinity', '-Infinity')
      OR OLD.commission_basis::text IN ('NaN', 'Infinity', '-Infinity')
      OR OLD.commission_amount::text IN ('NaN', 'Infinity', '-Infinity'))
    AND NEW.qualifying_sales::text ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$'
    AND NEW.commission_basis::text ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$'
    AND NEW.commission_rate::text ~ '^(?:0|1)(?:\.[0-9]{1,6})?$'
    AND NEW.adjustments::text ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$'
    AND NEW.commission_amount::text ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$'
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'commission_snapshots is immutable' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER commission_snapshots_immutable
  BEFORE UPDATE OR DELETE ON commission_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_commission_snapshot_mutation();
