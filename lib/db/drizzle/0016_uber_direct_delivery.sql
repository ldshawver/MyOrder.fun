ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_method" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_quote_id" text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_quote_snapshot" jsonb;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_fee" numeric(10, 2);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_currency" text;
