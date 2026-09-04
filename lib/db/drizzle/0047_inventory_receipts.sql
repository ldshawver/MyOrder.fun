ALTER TABLE "catalog_items"
  ADD CONSTRAINT "catalog_items_tenant_id_id_unique" UNIQUE ("tenant_id", "id");

CREATE TABLE "inventory_receipts" (
  "id" serial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "product_id" integer NOT NULL REFERENCES "catalog_items"("id"),
  "location_id" integer NOT NULL REFERENCES "inventory_locations"("id"),
  "quantity_received" numeric(10,3) NOT NULL CHECK ("quantity_received" > 0),
  "quantity_before" numeric(10,3) NOT NULL,
  "quantity_after" numeric(10,3) NOT NULL,
  "reason" text NOT NULL,
  "reference" text,
  "received_by_user_id" integer NOT NULL REFERENCES "users"("id"),
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inventory_receipts_tenant_id_id_unique" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "inventory_receipts_tenant_idempotency_unique" UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "inventory_receipts_product_tenant_fk" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "catalog_items"("tenant_id", "id"),
  CONSTRAINT "inventory_receipts_location_tenant_fk" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "inventory_locations"("tenant_id", "id"),
  CONSTRAINT "inventory_receipts_actor_tenant_fk" FOREIGN KEY ("tenant_id", "received_by_user_id") REFERENCES "users"("tenant_id", "id")
);
CREATE INDEX "inventory_receipts_product_location_created_idx" ON "inventory_receipts" ("tenant_id", "product_id", "location_id", "created_at");
