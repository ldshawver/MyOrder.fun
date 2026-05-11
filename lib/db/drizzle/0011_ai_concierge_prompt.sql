-- Task: AI Concierge prompt editor (Admin > Settings > AI)
-- Adds a nullable text column to admin_settings holding an admin-editable
-- system prompt for the AI concierge. NULL means "use the built-in default
-- prompt" (see artifacts/api-server/src/routes/ai.ts DEFAULT_AI_CONCIERGE_PROMPT).
-- The prompt may contain the placeholders {{itemCount}} and {{catalog}}
-- which are substituted server-side before being sent to the model.
ALTER TABLE admin_settings
  ADD COLUMN IF NOT EXISTS ai_concierge_prompt text;
