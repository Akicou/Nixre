-- 007_ai.sql — AI provider profiles (real credentials, server-side only).
-- API keys are encrypted at rest (AES-256-GCM, key from AI_SECRET env) and
-- never returned to the client (only a mask). Model lists fetched live from
-- the provider are cached here.

CREATE TABLE IF NOT EXISTS ai_provider_profiles (
  user_uid         TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  provider         TEXT NOT NULL DEFAULT 'deepseek',
  base_url         TEXT,                    -- custom/OpenAI-compatible endpoints
  api_key_enc      TEXT,                    -- encrypted blob (iv:tag:ct, base64)
  key_mask         TEXT,                    -- e.g. "…sk-9f2a" for UI display
  validated_at     BIGINT,                  -- last successful credential check
  model            TEXT NOT NULL DEFAULT 'deepseek-chat',
  reasoning_level  TEXT NOT NULL DEFAULT 'none',
  interleaved      BOOLEAN NOT NULL DEFAULT FALSE,
  model_cache      JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_cache_at   BIGINT,
  updated_at       BIGINT NOT NULL
);
