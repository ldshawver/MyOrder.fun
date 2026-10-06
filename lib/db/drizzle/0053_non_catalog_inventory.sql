CREATE TABLE IF NOT EXISTS "non_catalog_inventory_sections" (
  "id" serial PRIMARY KEY, "tenant_id" integer NOT NULL REFERENCES "tenants"("id"), "name" text NOT NULL,
  "display_order" integer NOT NULL DEFAULT 0, "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "non_catalog_sections_tenant_name" UNIQUE ("tenant_id", "name")
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='non_catalog_sections_tenant_id_unique') THEN
  ALTER TABLE "non_catalog_inventory_sections" ADD CONSTRAINT "non_catalog_sections_tenant_id_unique" UNIQUE ("tenant_id","id");
 END IF;
END $$;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "moq" numeric(10,3) NOT NULL DEFAULT 0;
ALTER TABLE "catalog_items" ADD COLUMN IF NOT EXISTS "preferred_reorder_quantity" numeric(10,3) NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS "non_catalog_inventory_items" (
  "id" serial PRIMARY KEY, "tenant_id" integer NOT NULL REFERENCES "tenants"("id"), "section_id" integer REFERENCES "non_catalog_inventory_sections"("id"),
  "name" text NOT NULL, "description" text, "sku" text, "barcode" text, "unit_of_measure" text NOT NULL DEFAULT 'each',
  "par_level" numeric(10,3) NOT NULL DEFAULT 0, "moq" numeric(10,3) NOT NULL DEFAULT 0, "preferred_reorder_quantity" numeric(10,3) NOT NULL DEFAULT 0,
  "unit_cost" numeric(10,2), "supplier" text, "supplier_sku" text, "notes" text, "image_url" text, "is_active" boolean NOT NULL DEFAULT true,
  "created_by_user_id" integer, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "non_catalog_items_tenant_name" UNIQUE ("tenant_id", "name")
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='non_catalog_items_tenant_id_unique') THEN
  ALTER TABLE "non_catalog_inventory_items" ADD CONSTRAINT "non_catalog_items_tenant_id_unique" UNIQUE ("tenant_id","id");
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='non_catalog_items_section_tenant_fk') THEN
  ALTER TABLE "non_catalog_inventory_items" ADD CONSTRAINT "non_catalog_items_section_tenant_fk" FOREIGN KEY ("tenant_id","section_id") REFERENCES "non_catalog_inventory_sections"("tenant_id","id");
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS "non_catalog_inventory_balances" (
  "id" serial PRIMARY KEY, "tenant_id" integer NOT NULL REFERENCES "tenants"("id"), "item_id" integer NOT NULL REFERENCES "non_catalog_inventory_items"("id"), "location_id" integer NOT NULL REFERENCES "inventory_locations"("id"), "quantity_on_hand" numeric(10,3) NOT NULL DEFAULT 0, "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "non_catalog_balances_tenant_item_location" UNIQUE ("tenant_id", "item_id", "location_id")
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='non_catalog_balances_item_tenant_fk') THEN
  ALTER TABLE "non_catalog_inventory_balances" ADD CONSTRAINT "non_catalog_balances_item_tenant_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "non_catalog_inventory_items"("tenant_id","id");
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='non_catalog_balances_location_tenant_fk') THEN
  ALTER TABLE "non_catalog_inventory_balances" ADD CONSTRAINT "non_catalog_balances_location_tenant_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "inventory_locations"("tenant_id","id");
 END IF;
END $$;
ALTER TABLE "non_catalog_inventory_items" ADD CONSTRAINT "non_catalog_items_par_nonnegative" CHECK ("par_level" >= 0);
ALTER TABLE "non_catalog_inventory_items" ADD CONSTRAINT "non_catalog_items_moq_nonnegative" CHECK ("moq" >= 0);
ALTER TABLE "non_catalog_inventory_items" ADD CONSTRAINT "non_catalog_items_reorder_nonnegative" CHECK ("preferred_reorder_quantity" >= 0);
ALTER TABLE "non_catalog_inventory_balances" ADD CONSTRAINT "non_catalog_balances_quantity_nonnegative" CHECK ("quantity_on_hand" >= 0);
CREATE INDEX IF NOT EXISTS "non_catalog_items_tenant_section_idx" ON "non_catalog_inventory_items" ("tenant_id","section_id");
CREATE INDEX IF NOT EXISTS "non_catalog_balances_tenant_location_idx" ON "non_catalog_inventory_balances" ("tenant_id","location_id");
