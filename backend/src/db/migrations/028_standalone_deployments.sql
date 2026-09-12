-- Keep legacy rows, references, secrets and repo/name uniqueness intact.
ALTER TABLE deploy_services
  ADD COLUMN space_uid TEXT REFERENCES spaces(uid) ON UPDATE CASCADE ON DELETE CASCADE,
  ADD COLUMN source_type TEXT NOT NULL DEFAULT 'repo' CHECK (source_type IN ('repo', 'git', 'image')),
  ADD COLUMN git_url TEXT,
  ADD COLUMN image_ref TEXT,
  ADD COLUMN build_target TEXT,
  ADD COLUMN template TEXT CHECK (template IN ('postgres')),
  ADD COLUMN exposure TEXT NOT NULL DEFAULT 'http' CHECK (exposure IN ('http', 'internal')),
  ADD COLUMN deployment_strategy TEXT NOT NULL DEFAULT 'blue_green' CHECK (deployment_strategy IN ('blue_green', 'recreate')),
  ADD COLUMN volume_path TEXT;

UPDATE deploy_services s SET space_uid = r.space_uid FROM repos r WHERE r.id = s.repo_id;
ALTER TABLE deploy_services ALTER COLUMN repo_id DROP NOT NULL;
ALTER TABLE deploy_services ADD CONSTRAINT deploy_services_source_check CHECK (
  (source_type = 'repo' AND repo_id IS NOT NULL) OR
  (source_type IN ('git', 'image') AND repo_id IS NULL AND space_uid IS NOT NULL AND NOT auto_deploy)
);
ALTER TABLE deploy_services ADD CONSTRAINT deploy_services_volume_strategy_check
  CHECK (volume_path IS NULL OR deployment_strategy = 'recreate');
CREATE UNIQUE INDEX deploy_services_standalone_name ON deploy_services (space_uid, name) WHERE repo_id IS NULL;
CREATE INDEX deploy_services_by_space ON deploy_services (space_uid);
ALTER TABLE deployments ADD COLUMN config_snapshot JSONB;
