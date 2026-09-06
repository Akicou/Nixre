-- Preserve the effective Docker policy of existing services on recreation.
-- New services opt into least-privilege defaults; administrators can migrate
-- existing images explicitly after testing their entrypoint requirements.
ALTER TABLE deploy_services
  ADD COLUMN security_policy_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE deploy_services
  ALTER COLUMN security_policy_version SET DEFAULT 2;

ALTER TABLE deploy_services
  ADD CONSTRAINT deploy_services_security_policy_version_check
  CHECK (security_policy_version IN (1, 2));
