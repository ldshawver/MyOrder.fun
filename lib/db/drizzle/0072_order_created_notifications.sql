-- Durable, tenant-scoped post-commit order alerts. Disabled until an admin opts in.
CREATE TABLE order_notification_settings (
  tenant_id integer PRIMARY KEY REFERENCES tenants(id),
  light_enabled boolean NOT NULL DEFAULT false,
  sms_enabled boolean NOT NULL DEFAULT false,
  alert_duration_seconds integer NOT NULL DEFAULT 60 CHECK (alert_duration_seconds BETWEEN 10 AND 600),
  general_assignee_user_id integer,
  general_fallback_user_id integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, general_assignee_user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, general_fallback_user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE order_notification_events (
  id bigserial PRIMARY KEY,
  tenant_id integer NOT NULL,
  order_id integer NOT NULL,
  event_type text NOT NULL CHECK (event_type = 'ORDER_CREATED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_id, event_type),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
);

CREATE TABLE order_notification_jobs (
  id bigserial PRIMARY KEY,
  tenant_id integer NOT NULL,
  event_id bigint NOT NULL,
  order_id integer NOT NULL,
  notification_type text NOT NULL CHECK (notification_type IN ('tuya_on', 'staff_sms')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'processing', 'succeeded', 'skipped', 'failed', 'uncertain')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  recipient_user_id integer,
  masked_destination text,
  provider_reference text,
  failure_class text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_id, notification_type),
  FOREIGN KEY (tenant_id, event_id) REFERENCES order_notification_events(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, recipient_user_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX order_notification_jobs_due_idx ON order_notification_jobs (next_attempt_at, id)
  WHERE state IN ('queued', 'processing');

-- A due row is the durable delayed OFF job. generation changes whenever an
-- order extends the deadline; the OFF worker checks it under a row lock.
CREATE TABLE order_light_alerts (
  tenant_id integer PRIMARY KEY REFERENCES tenants(id),
  device_alias text NOT NULL DEFAULT 'MyOrder.fun',
  off_at timestamptz,
  generation bigint NOT NULL DEFAULT 0,
  is_on boolean NOT NULL DEFAULT false,
  on_result text,
  off_result text,
  off_attempts integer NOT NULL DEFAULT 0,
  off_next_attempt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
