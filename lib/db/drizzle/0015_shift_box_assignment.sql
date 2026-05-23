ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "box_assignment_id" text;
ALTER TABLE "lab_tech_shifts" ADD COLUMN IF NOT EXISTS "setup_json" jsonb DEFAULT '{}'::jsonb;
