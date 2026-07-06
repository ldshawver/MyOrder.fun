ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "order_type" text NOT NULL DEFAULT 'ONLINE';

ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "inventory_deductions" jsonb NOT NULL DEFAULT '[]'::jsonb;
