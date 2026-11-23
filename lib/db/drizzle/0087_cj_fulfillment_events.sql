-- Durable CJ/Woo fulfillment identity and idempotent provider-event inbox.
-- Event authentication and state reconciliation are implemented separately;
-- these tables ensure provider callbacks can never select a group by an
-- unscoped order identifier or overwrite immutable checkout snapshots.
CREATE TABLE IF NOT EXISTS "cj_order_fulfillments" (
  "id" bigserial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "order_id" integer NOT NULL,
  "fulfillment_group_id" integer NOT NULL,
  "provider_order_id" text NOT NULL,
  "provider_status" text NOT NULL DEFAULT 'pending',
  "reconciliation_state" text NOT NULL DEFAULT 'pending',
  "last_provider_event_at" timestamptz,
  "last_reconciled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cj_order_fulfillments_tenant_order_fk"
    FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id"),
  CONSTRAINT "cj_order_fulfillments_group_fk"
    FOREIGN KEY ("order_id", "fulfillment_group_id") REFERENCES "order_fulfillment_groups"("order_id", "id"),
  CONSTRAINT "cj_order_fulfillments_tenant_group_unique" UNIQUE ("tenant_id", "fulfillment_group_id"),
  CONSTRAINT "cj_order_fulfillments_tenant_provider_order_unique" UNIQUE ("tenant_id", "provider_order_id"),
  CONSTRAINT "cj_order_fulfillments_tenant_id_id_unique" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "cj_order_fulfillments_status_check"
    CHECK ("provider_status" IN ('pending', 'processing', 'on_hold', 'completed', 'cancelled', 'failed', 'refunded')),
  CONSTRAINT "cj_order_fulfillments_reconciliation_check"
    CHECK ("reconciliation_state" IN ('pending', 'in_sync', 'reconciliation_required'))
);

CREATE TABLE IF NOT EXISTS "cj_fulfillment_events" (
  "id" bigserial PRIMARY KEY,
  "tenant_id" integer NOT NULL REFERENCES "tenants"("id"),
  "fulfillment_id" bigint NOT NULL,
  "provider_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "provider_order_id" text NOT NULL,
  "provider_status" text NOT NULL,
  "payload_sha256" text NOT NULL,
  "provider_event_at" timestamptz,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  CONSTRAINT "cj_fulfillment_events_tenant_fulfillment_fk"
    FOREIGN KEY ("tenant_id", "fulfillment_id") REFERENCES "cj_order_fulfillments"("tenant_id", "id"),
  CONSTRAINT "cj_fulfillment_events_tenant_event_unique" UNIQUE ("tenant_id", "provider_event_id"),
  CONSTRAINT "cj_fulfillment_events_payload_sha256_check" CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS "cj_order_fulfillments_reconciliation_idx"
  ON "cj_order_fulfillments" ("tenant_id", "reconciliation_state", "updated_at");
CREATE INDEX IF NOT EXISTS "cj_fulfillment_events_lookup_idx"
  ON "cj_fulfillment_events" ("tenant_id", "provider_order_id", "received_at");
