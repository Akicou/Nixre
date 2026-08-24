-- 018_conversation_runs.sql — server-side agent job status + queue.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS run_status TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS run_error  TEXT,
  ADD COLUMN IF NOT EXISTS run_queue  JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_run_status_check;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_run_status_check
  CHECK (run_status IN ('idle', 'running', 'stopping'));
