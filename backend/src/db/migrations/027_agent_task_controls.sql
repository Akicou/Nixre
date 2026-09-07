-- Durable agent task controls and per-user project memory.
CREATE TABLE IF NOT EXISTS agent_task_state (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_project_memory (
  user_id TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  repo_path TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, repo_path)
);
