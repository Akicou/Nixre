-- 024_deploy_runtime_options.sql — optional per-service Docker runtime
-- options (bind mounts, capabilities, network mode, command overrides,
-- health-check path/timeout). NULL keeps the legacy behavior exactly.
-- Validation + safety gating live in lib/deployRuntimeOptions.js; this column
-- only stores the normalized JSON the API accepted.

ALTER TABLE deploy_services ADD COLUMN IF NOT EXISTS runtime_options JSONB;
