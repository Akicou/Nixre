-- 033_issues_security_scan.sql — repository issues, and the history of the
-- built-in security scanner that files them.
--
-- `fingerprint` lets the scanner re-find "its" issue on the next run instead of
-- opening a duplicate every three hours. It is NULL for human-written issues.

CREATE TABLE IF NOT EXISTS issues (
  id          BIGSERIAL PRIMARY KEY,
  repo_id     BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number      BIGINT NOT NULL,                 -- per-repo issue number (1, 2, ...)
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  labels      JSONB NOT NULL DEFAULT '[]'::jsonb,
  author_uid  TEXT NOT NULL REFERENCES users(uid),
  source      TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','security-scan')),
  fingerprint TEXT,
  created     BIGINT NOT NULL,
  updated     BIGINT NOT NULL,
  closed      BIGINT,
  UNIQUE (repo_id, number)
);
CREATE INDEX IF NOT EXISTS issues_by_repo_state ON issues (repo_id, state, created DESC);
CREATE UNIQUE INDEX IF NOT EXISTS issues_by_fingerprint
  ON issues (repo_id, fingerprint) WHERE fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS issue_comments (
  id         BIGSERIAL PRIMARY KEY,
  issue_id   BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_uid TEXT NOT NULL REFERENCES users(uid),
  body       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','security-scan')),
  created    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS issue_comments_by_issue ON issue_comments (issue_id, id);

CREATE TABLE IF NOT EXISTS security_scans (
  id             BIGSERIAL PRIMARY KEY,
  started        BIGINT NOT NULL,
  finished       BIGINT,
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error','skipped')),
  trigger_kind   TEXT NOT NULL DEFAULT 'schedule' CHECK (trigger_kind IN ('schedule','manual')),
  summary        TEXT NOT NULL DEFAULT '',
  error          TEXT,
  findings       INTEGER NOT NULL DEFAULT 0,
  issues_created INTEGER NOT NULL DEFAULT 0,
  fingerprint    TEXT,                          -- hash of the finding set; unchanged => AI is not re-run
  report         JSONB
);
CREATE INDEX IF NOT EXISTS security_scans_recent ON security_scans (started DESC);
