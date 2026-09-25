-- 031_actions.sql — Nixre Actions (CI/CD), commit statuses, repo secrets,
-- required checks, and stars.
--
-- Workflows live in the repository (`.nixre/workflows/*.yml`, with
-- `.gitea/workflows` and `.github/workflows` as fallbacks). Runs, jobs and
-- their logs are recorded here; every finished job also writes a commit
-- status, which is what the PR merge gate reads.

CREATE TABLE IF NOT EXISTS workflow_runs (
  id             BIGSERIAL PRIMARY KEY,
  repo_id        BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  run_number     BIGINT NOT NULL,             -- per-repo, 1, 2, ...
  workflow_path  TEXT NOT NULL,               -- e.g. .nixre/workflows/ci.yml
  workflow_name  TEXT NOT NULL,
  event          TEXT NOT NULL
                 CHECK (event IN ('push','pull_request','schedule','workflow_dispatch')),
  ref            TEXT NOT NULL,               -- refs/heads/main, refs/tags/v1
  sha            TEXT NOT NULL,
  pr_number      BIGINT,
  actor          TEXT NOT NULL DEFAULT '',
  inputs         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','completed')),
  conclusion     TEXT
                 CHECK (conclusion IS NULL OR conclusion IN ('success','failure','cancelled','skipped')),
  error          TEXT,
  created        BIGINT NOT NULL,
  started        BIGINT,
  finished       BIGINT,
  UNIQUE (repo_id, run_number)
);
CREATE INDEX IF NOT EXISTS workflow_runs_by_repo ON workflow_runs (repo_id, id DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_by_sha ON workflow_runs (repo_id, sha);

CREATE TABLE IF NOT EXISTS workflow_jobs (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  job_key     TEXT NOT NULL,                  -- the `jobs.<key>` id
  name        TEXT NOT NULL,                  -- display name, matrix-expanded
  matrix      JSONB NOT NULL DEFAULT '{}'::jsonb,
  needs       JSONB NOT NULL DEFAULT '[]'::jsonb,
  image       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','completed')),
  conclusion  TEXT
              CHECK (conclusion IS NULL OR conclusion IN ('success','failure','cancelled','skipped')),
  steps       JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{name,status,conclusion,started,finished}]
  log         TEXT NOT NULL DEFAULT '',
  started     BIGINT,
  finished    BIGINT
);
CREATE INDEX IF NOT EXISTS workflow_jobs_by_run ON workflow_jobs (run_id, id);

-- Per-repo encrypted secrets, exposed to workflows as ${{ secrets.NAME }}.
-- Re-encrypted on key rotation by db/migrate.js reencryptSecrets().
CREATE TABLE IF NOT EXISTS repo_secrets (
  repo_id    BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value_enc  TEXT NOT NULL,
  updated    BIGINT NOT NULL,
  PRIMARY KEY (repo_id, key)
);

-- Commit statuses (GitHub-style). One row per (sha, context); a rerun
-- overwrites its context.
CREATE TABLE IF NOT EXISTS commit_statuses (
  repo_id      BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  sha          TEXT NOT NULL,
  context      TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending','success','failure','error')),
  description  TEXT NOT NULL DEFAULT '',
  target_url   TEXT NOT NULL DEFAULT '',
  created      BIGINT NOT NULL,
  updated      BIGINT NOT NULL,
  PRIMARY KEY (repo_id, sha, context)
);

-- Branch protection, deliberately small: when set, a PR only merges once
-- every commit status on its head is green (and there is at least one).
ALTER TABLE repos ADD COLUMN IF NOT EXISTS require_checks BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS repo_stars (
  repo_id   BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  user_uid  TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  created   BIGINT NOT NULL,
  PRIMARY KEY (repo_id, user_uid)
);
CREATE INDEX IF NOT EXISTS repo_stars_by_user ON repo_stars (user_uid);

-- `uses: nixre/deploy@v1` releases a service from a workflow.
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_trigger_kind_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_trigger_kind_check
  CHECK (trigger_kind IN ('manual','push','boot','rollback','redeploy','workflow'));
