-- Per-user durable preference and idempotent push delivery queue for new orders.
ALTER TABLE users ADD COLUMN web_push_order_alerts_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE order_push_notification_jobs (
  id bigserial PRIMARY KEY,
  tenant_id integer NOT NULL,
  event_id bigint NOT NULL,
  order_id integer NOT NULL,
  recipient_user_id integer NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','succeeded','skipped','failed','uncertain')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  failure_class text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,event_id,recipient_user_id),
  FOREIGN KEY (tenant_id,event_id) REFERENCES order_notification_events(tenant_id,id),
  FOREIGN KEY (tenant_id,order_id) REFERENCES orders(tenant_id,id),
  FOREIGN KEY (tenant_id,recipient_user_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX order_push_notification_jobs_due_idx ON order_push_notification_jobs(next_attempt_at,id)
  WHERE state IN ('queued','processing');
