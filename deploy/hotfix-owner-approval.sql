-- P0 authorization schema patch. Apply directly to the production-compatible
-- database at migration lineage 0067. Do not run the general migration job:
-- 0068_print_jobs_document_job_types is an unrelated deferred migration.
BEGIN;

CREATE TABLE IF NOT EXISTS public.myorder_hotfix_migrations (
  migration_id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS approved_by_clerk_id text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

CREATE INDEX IF NOT EXISTS users_owner_approval_provenance_idx
  ON public.users (approved_by_clerk_id, approved_at)
  WHERE status = 'approved';

INSERT INTO public.myorder_hotfix_migrations (migration_id)
VALUES ('p0_owner_approval_provenance')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
