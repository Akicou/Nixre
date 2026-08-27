-- 021_deployments.sql — Docker app deployments per repo: services (root-dir +
-- Dockerfile + branch), releases, env vars, HTTP request logs, uptime checks,
-- and custom domains routed through the central deploy proxy.

CREATE TABLE IF NOT EXISTS deploy_services (
  id                 BIGSERIAL PRIMARY KEY,
  repo_id            BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  root_dir           TEXT NOT NULL DEFAULT '.',
  dockerfile_path    TEXT NOT NULL DEFAULT 'Dockerfile', -- relative to root_dir
  branch             TEXT NOT NULL DEFAULT 'main',
  auto_deploy        BOOLEAN NOT NULL DEFAULT TRUE,
  container_port     INTEGER NOT NULL DEFAULT 8080,
  cpu_nano_cpus      BIGINT NOT NULL DEFAULT 1000000000,   -- 1 core
  memory_bytes       BIGINT NOT NULL DEFAULT 536870912,    -- 512 MiB
  desired_state      TEXT NOT NULL DEFAULT 'running'
                     CHECK (desired_state IN ('running','stopped')),
  status             TEXT NOT NULL DEFAULT 'idle'
                     CHECK (status IN ('idle','deploying','running','stopped','failed')),
  current_deployment_id    BIGINT,
  last_failed_deployment_id BIGINT,
  created_by         TEXT NOT NULL REFERENCES users(uid),
  created            BIGINT NOT NULL,
  updated            BIGINT NOT NULL,
  UNIQUE (repo_id, name)
);

ALTER TABLE deploy_services ADD COLUMN IF NOT EXISTS preserve_status_min INTEGER NOT NULL DEFAULT 400;
ALTER TABLE deploy_services ADD COLUMN IF NOT EXISTS success_retention_hours INTEGER NOT NULL DEFAULT 24;
ALTER TABLE deploy_services ADD COLUMN IF NOT EXISTS failure_retention_hours INTEGER NOT NULL DEFAULT 168;

CREATE TABLE IF NOT EXISTS deployments (
  id            BIGSERIAL PRIMARY KEY,
  service_id    BIGINT NOT NULL REFERENCES deploy_services(id) ON DELETE CASCADE,
  ref           TEXT NOT NULL DEFAULT '',
  sha           TEXT NOT NULL DEFAULT '',
  message       TEXT NOT NULL DEFAULT '',
  -- `trigger_kind` because TRIGGER is a reserved word in Postgres.
  trigger_kind  TEXT NOT NULL DEFAULT 'manual'
                CHECK (trigger_kind IN ('manual','push','boot','rollback','redeploy')),
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','building','releasing','live','failed','cancelled')),
  error         TEXT,
  build_log     TEXT NOT NULL DEFAULT '',
  image_tag     TEXT,
  started       BIGINT NOT NULL,
  finished      BIGINT,
  duration_ms   BIGINT
);
CREATE INDEX IF NOT EXISTS deployments_by_service ON deployments (service_id, started DESC);

DO $$ BEGIN
  ALTER TABLE deploy_services ADD CONSTRAINT deploy_services_current_fk
    FOREIGN KEY (current_deployment_id) REFERENCES deployments(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE deploy_services ADD CONSTRAINT deploy_services_failed_fk
    FOREIGN KEY (last_failed_deployment_id) REFERENCES deployments(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;

-- Injected at container create, like Railway env groups. AES-256-GCM blobs
-- share the AI-provider secret format; plaintext never leaves the server
-- except through the explicit reveal endpoint.
CREATE TABLE IF NOT EXISTS service_env_vars (
  service_id BIGINT NOT NULL REFERENCES deploy_services(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value_enc  TEXT NOT NULL,
  updated    BIGINT NOT NULL,
  PRIMARY KEY (service_id, key)
);

-- One row per proxied request. Retention is enforced by the deployment sweep:
-- rows with status_code >= preserve_status_min outlive plain successes.
CREATE TABLE IF NOT EXISTS deploy_http_logs (
  id          BIGSERIAL PRIMARY KEY,
  service_id  BIGINT NOT NULL REFERENCES deploy_services(id) ON DELETE CASCADE,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL DEFAULT '',
  status_code INTEGER,
  duration_ms INTEGER,
  ts          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS http_logs_recent ON deploy_http_logs (service_id, ts DESC);
CREATE INDEX IF NOT EXISTS http_logs_status ON deploy_http_logs (service_id, status_code);

-- One row per probe tick; charted as up/down buckets.
CREATE TABLE IF NOT EXISTS deploy_uptime_checks (
  id          BIGSERIAL PRIMARY KEY,
  service_id  BIGINT NOT NULL REFERENCES deploy_services(id) ON DELETE CASCADE,
  ok          BOOLEAN NOT NULL,
  latency_ms  INTEGER,
  status_code INTEGER,
  ts          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS uptime_recent ON deploy_uptime_checks (service_id, ts DESC);

-- Custom domains routed through the central proxy (kind = how public traffic
-- reaches this Nixre host: host Caddy or a Cloudflare Tunnel).
CREATE TABLE IF NOT EXISTS deploy_domains (
  id         BIGSERIAL PRIMARY KEY,
  service_id BIGINT NOT NULL REFERENCES deploy_services(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'caddy' CHECK (kind IN ('caddy','tunnel')),
  domain     TEXT NOT NULL UNIQUE,
  created    BIGINT NOT NULL
);
