-- 002_sync.sql — account-scoped UI state (absorbed from nixre-sync).
-- user_id is the users.uid (TEXT) — matches the sync service's uid keying.

CREATE TABLE IF NOT EXISTS prefs (
  user_id    TEXT         NOT NULL,
  key        TEXT         NOT NULL,
  value      JSONB        NOT NULL,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT         NOT NULL,
  user_id    TEXT         NOT NULL,
  repo_path  TEXT         NOT NULL,
  title      TEXT         NOT NULL DEFAULT 'Untitled',
  messages   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS conversations_by_repo
  ON conversations (user_id, repo_path, updated_at DESC);

CREATE TABLE IF NOT EXISTS passkeys (
  id           TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  user_uid     TEXT    NOT NULL,
  user_email   TEXT    NOT NULL DEFAULT '',
  public_key   TEXT,
  created_at   BIGINT  NOT NULL,
  last_used_at BIGINT,
  PRIMARY KEY (id)
);
