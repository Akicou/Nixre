-- 008_ai_providers.sql — multiple AI providers per user (phase: multi-AI).
--
-- Each row is one provider configuration (DeepSeek, OpenAI, Anthropic,
-- Ollama, custom endpoints...) with its own encrypted key and cached model
-- list. `enabled_models` is the user's hand-picked subset of the fetched
-- models that appears in chat pickers. `is_default` marks the active one
-- (exactly one per user at most).
--
-- Legacy: 007's ai_provider_profiles remains as the pre-multi-provider
-- store; it is migrated into ai_providers lazily on first read.

CREATE TABLE IF NOT EXISTS ai_providers (
  id              BIGSERIAL PRIMARY KEY,
  user_uid        TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  label           TEXT NOT NULL,           -- user-chosen display name
  provider        TEXT NOT NULL,           -- deepseek | openai | anthropic | ollama | custom
  base_url        TEXT,
  api_key_enc     TEXT,                    -- AES-256-GCM blob
  key_mask        TEXT,
  validated_at    BIGINT,
  default_model   TEXT NOT NULL DEFAULT '',
  model_cache     JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_cache_at  BIGINT,
  enabled_models  JSONB NOT NULL DEFAULT '[]'::jsonb, -- picked subset for chat
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  created         BIGINT NOT NULL,
  updated         BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_providers_by_user_label
  ON ai_providers (user_uid, label);
CREATE INDEX IF NOT EXISTS ai_providers_by_user
  ON ai_providers (user_uid);
