-- 004_pull_requests.sql — sovereign pull requests (phase 3).

CREATE TABLE IF NOT EXISTS pull_requests (
  id             BIGSERIAL PRIMARY KEY,
  repo_id        BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number         BIGINT NOT NULL,          -- per-repo PR number (1, 2, ...)
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  source_branch  TEXT NOT NULL,
  target_branch  TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'open', -- open | merged | closed
  is_draft       BOOLEAN NOT NULL DEFAULT FALSE,
  author_uid     TEXT NOT NULL REFERENCES users(uid),
  merged_by_uid  TEXT REFERENCES users(uid),
  created        BIGINT NOT NULL,
  updated        BIGINT NOT NULL,
  merged         BIGINT,
  UNIQUE (repo_id, number)
);
CREATE INDEX IF NOT EXISTS pull_requests_by_repo_state
  ON pull_requests (repo_id, state);
