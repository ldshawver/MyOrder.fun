CREATE TABLE IF NOT EXISTS "csr_boxes" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"location" text,
	"is_active" boolean NOT NULL DEFAULT true,
	"display_order" integer NOT NULL DEFAULT 0,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "csr_boxes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
);
