ALTER TABLE order_notification_settings
  ADD COLUMN IF NOT EXISTS sms_provider text NOT NULL DEFAULT 'twilio',
  ADD COLUMN IF NOT EXISTS sms_sender text,
  ADD COLUMN IF NOT EXISTS sms_credentials_ciphertext text,
  ADD COLUMN IF NOT EXISTS tuya_region text,
  ADD COLUMN IF NOT EXISTS tuya_device_id text,
  ADD COLUMN IF NOT EXISTS tuya_switch_code text NOT NULL DEFAULT 'switch_1',
  ADD COLUMN IF NOT EXISTS tuya_credentials_ciphertext text,
  ADD COLUMN IF NOT EXISTS sms_connection_status text NOT NULL DEFAULT 'not_configured',
  ADD COLUMN IF NOT EXISTS tuya_connection_status text NOT NULL DEFAULT 'not_configured',
  ADD COLUMN IF NOT EXISTS sms_last_test_at timestamptz,
  ADD COLUMN IF NOT EXISTS tuya_last_test_at timestamptz;

ALTER TABLE order_notification_settings
  ADD CONSTRAINT order_notification_settings_sms_provider_check CHECK (sms_provider IN ('twilio')),
  ADD CONSTRAINT order_notification_settings_tuya_region_check CHECK (tuya_region IS NULL OR tuya_region IN ('us','eu','in','cn','ueaz','weaz')),
  ADD CONSTRAINT order_notification_settings_sms_status_check CHECK (sms_connection_status IN ('not_configured','connected','failed')),
  ADD CONSTRAINT order_notification_settings_tuya_status_check CHECK (tuya_connection_status IN ('not_configured','connected','failed'));

ALTER TABLE admin_settings
  ADD COLUMN IF NOT EXISTS cash_tax_inclusive boolean NOT NULL DEFAULT false;
