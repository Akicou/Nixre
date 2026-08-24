-- 017_user_stt.sql — OpenAI-compatible speech-to-text endpoint per user.
-- API key encrypted with the same AES-256-GCM scheme as AI providers.

CREATE TABLE IF NOT EXISTS user_stt (
  user_uid    TEXT PRIMARY KEY REFERENCES users(uid) ON DELETE CASCADE,
  base_url    TEXT NOT NULL,
  model       TEXT NOT NULL,
  api_key_enc TEXT,
  key_mask    TEXT,
  updated     BIGINT NOT NULL
);
