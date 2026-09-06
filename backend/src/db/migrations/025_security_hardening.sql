-- 025_security_hardening.sql — session token hashing, domain ownership,
-- encrypted webhook secrets.
--
-- Applied idempotently by src/db/migrate.js on boot.
--
-- NOTE ON SESSIONS: session rows used to store the bearer token itself in
-- `sessions.id`, so a database read was enough to impersonate any logged-in
-- user. Sessions now carry a separate opaque row id plus `token_hash`
-- (sha256 of the bearer token) and only the hash is stored. Existing rows
-- could be hashed, but are intentionally revoked: every user is signed out
-- once by this migration. That is the
-- safe direction — a leaked token dies here instead of living on.

-- --- sessions: stop storing the bearer token in the clear --------------------
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_by_token_hash ON sessions (token_hash);

-- Revoke legacy bearer tokens instead of preserving possibly leaked sessions.
DELETE FROM sessions WHERE token_hash IS NULL;

-- --- deploy_domains: prove ownership before we route traffic -----------------
--
-- Previously any space writer could attach an arbitrary hostname (including
-- the forge's own) and the deploy proxy would serve their container for it.
-- Attaching a domain now parks it as unverified: it is only routed once
-- ownership is proven (DNS TXT challenge, or auto-DNS in a zone the operator's
-- Cloudflare token controls).
ALTER TABLE deploy_domains ADD COLUMN IF NOT EXISTS verified     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE deploy_domains ADD COLUMN IF NOT EXISTS verify_token TEXT;
ALTER TABLE deploy_domains ADD COLUMN IF NOT EXISTS verified_at  BIGINT;

-- Domains attached before this migration were routed unconditionally. Keep
-- them routed (no surprise outages). Operators must audit existing claims;
-- reserved hostnames are still excluded by the final proxy route table.
UPDATE deploy_domains SET verified = TRUE, verified_at = created WHERE verified_at IS NULL;

-- --- repo_webhooks: keep the signing secret encrypted at rest ----------------
--
-- New secrets are encrypted with the instance key and stored in `secret_enc`;
-- `secret` is written as '' for those rows. A database read no longer yields a
-- usable credential for anything created from here on.
--
-- migrate.js encrypts legacy plaintext with AES-GCM inside the same transaction
-- after SQL migrations, verifies readback, and clears the plaintext column.
ALTER TABLE repo_webhooks ADD COLUMN IF NOT EXISTS secret_enc TEXT;

-- --- webhook_deliveries: record why a delivery failed --------------------------
-- Used to distinguish "target refused by policy" (stop retrying) from a
-- transient network error (keep retrying).
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS error TEXT;

-- --- rate limiting state (best-effort, in-memory; also used for login lockout)
CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket     TEXT PRIMARY KEY,             -- e.g. 'login:1.2.3.4:<window-start>'
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT  NOT NULL
);
