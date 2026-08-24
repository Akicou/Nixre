-- 016_user_secrets.sql — encrypted third-party credentials for the agent.
-- GitHub PAT is kind='github'; more kinds can share this table later.
-- AES-256-GCM blobs (same format as ai_providers.api_key_enc).

CREATE TABLE IF NOT EXISTS user_secrets (
  user_uid   TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  key_mask   TEXT,
  updated    BIGINT NOT NULL,
  PRIMARY KEY (user_uid, kind)
);
