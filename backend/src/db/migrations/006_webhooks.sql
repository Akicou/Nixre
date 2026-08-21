-- 006_webhooks.sql — repo webhooks with signed deliveries (phase 5).

CREATE TABLE IF NOT EXISTS repo_webhooks (
  id          BIGSERIAL PRIMARY KEY,
  repo_id     BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,            -- HMAC-SHA256 signing secret
  events      TEXT[] NOT NULL DEFAULT '{push,pull_request}', -- subscribed events
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  TEXT NOT NULL REFERENCES users(uid),
  created     BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           BIGSERIAL PRIMARY KEY,
  webhook_id   BIGINT NOT NULL REFERENCES repo_webhooks(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  status_code  INTEGER,                 -- null = not yet delivered / network error
  ok           BOOLEAN NOT NULL DEFAULT FALSE,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_retry   BIGINT,                  -- ms epoch; null when done or given up
  payload      JSONB NOT NULL,
  created      BIGINT NOT NULL,
  delivered    BIGINT
);
CREATE INDEX IF NOT EXISTS webhook_pending ON webhook_deliveries (next_retry)
  WHERE next_retry IS NOT NULL;
