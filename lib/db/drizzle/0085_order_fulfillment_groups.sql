-- Immutable server-created fulfillment groups for mixed-cart checkout.
-- fulfillment_group_id remains nullable so historical orders are preserved;
-- grouped checkout writes enforce one group per new order line transactionally.
CREATE TABLE IF NOT EXISTS "order_fulfillment_groups" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "order_id" integer NOT NULL REFERENCES "orders"("id"),
  "group_key" text NOT NULL,
  "provider" text NOT NULL,
  "inventory_owner_snapshot" text NOT NULL,
  "fulfillment_origin_snapshot" jsonb NOT NULL,
  "method" text NOT NULL,
  "destination_snapshot" jsonb NOT NULL,
  "quote_id" text,
  "quote_snapshot" jsonb,
  "merchandise_subtotal" numeric(12,2) NOT NULL,
  "fee" numeric(12,2) NOT NULL DEFAULT 0,
  "tax" numeric(12,2) NOT NULL DEFAULT 0,
  "total" numeric(12,2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'usd',
  "tax_snapshot" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'submitted',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "order_fulfillment_groups_order_key_unique" UNIQUE ("order_id", "group_key"),
  CONSTRAINT "order_fulfillment_groups_order_id_id_unique" UNIQUE ("order_id", "id"),
  CONSTRAINT "order_fulfillment_groups_tenant_order_fk" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id"),
  CONSTRAINT "order_fulfillment_groups_provider_check" CHECK ("provider" IN ('alavont', 'lucifer_direct', 'cj')),
  CONSTRAINT "order_fulfillment_groups_method_check" CHECK ("method" IN ('pickup', 'uber_direct', 'csr_delivery', 'carrier', 'standard_shipping')),
  CONSTRAINT "order_fulfillment_groups_amounts_check" CHECK ("merchandise_subtotal" >= 0 AND "fee" >= 0 AND "tax" >= 0 AND "total" = "merchandise_subtotal" + "fee" + "tax")
);

ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "fulfillment_group_id" integer;

DO $$ BEGIN
  ALTER TABLE "order_items" ADD CONSTRAINT "order_items_fulfillment_group_order_fk"
    FOREIGN KEY ("order_id", "fulfillment_group_id")
    REFERENCES "order_fulfillment_groups"("order_id", "id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
