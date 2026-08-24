-- 019_agent_env_feedback.sql — operator-scannable sandbox/tool gap reports.

CREATE TABLE IF NOT EXISTS agent_env_feedback (
  id               TEXT         PRIMARY KEY,
  user_id          TEXT         NOT NULL,
  conversation_id  TEXT,
  repo_path        TEXT         NOT NULL,
  report           JSONB        NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_env_feedback_by_created
  ON agent_env_feedback (created_at DESC);

CREATE INDEX IF NOT EXISTS agent_env_feedback_by_user
  ON agent_env_feedback (user_id, created_at DESC);
