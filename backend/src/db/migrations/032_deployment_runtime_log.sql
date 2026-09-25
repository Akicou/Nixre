-- 032_deployment_runtime_log.sql — keep the container's own output when a
-- release fails.
--
-- A build failure lands in deployments.build_log, but a release failure
-- ("Health check failed: app did not answer on port 8080 / within 30s") wrote
-- nothing: the container that printed the real reason (bad env var, migration
-- crash, wrong listen address) was removed by the failure handler, taking its
-- stdout/stderr with it. Agents and humans were then told to "inspect the
-- failed build" and found a build log that succeeded.
--
-- The failure path now tails the container's log into this column BEFORE
-- removing it, so the deployment row carries why the app never answered.

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS runtime_log TEXT;
