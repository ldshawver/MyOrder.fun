-- Phase 2: Per-location inventory model
-- Two new tables only. Nothing existing is dropped or altered.
-- Rollback: DROP TABLE inventory_balances; DROP TABLE inventory_locations;

CREATE TABLE IF NOT EXISTS "inventory_locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"type" text NOT NULL,
	"csr_box_id" integer,
	"name" text NOT NULL,
	"is_active" boolean NOT NULL DEFAULT true,
	"display_order" integer NOT NULL DEFAULT 0,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "inventory_locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
	CONSTRAINT "inventory_locations_csr_box_id_fkey" FOREIGN KEY ("csr_box_id") REFERENCES "csr_boxes"("id")
);

CREATE TABLE IF NOT EXISTS "inventory_balances" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"quantity_on_hand" numeric(10, 3) NOT NULL DEFAULT 0,
	"par_level" numeric(10, 2) NOT NULL DEFAULT 0,
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "inventory_balances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id"),
	CONSTRAINT "inventory_balances_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "catalog_items"("id") ON DELETE CASCADE,
	CONSTRAINT "inventory_balances_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id"),
	CONSTRAINT "inventory_balances_unique" UNIQUE ("tenant_id", "product_id", "location_id")
);
