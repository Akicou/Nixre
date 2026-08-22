-- 009_passkeys_webauthn.sql — server-verified WebAuthn login.
--
-- passkeys.public_key existed but was never filled; registrations now store
-- the COSE public key plus the algorithm and rpId they were created for, so
-- the login-challenge endpoint can verify assertions server-side and mint a
-- real session. sign_count tracks authenticator counters for replay hygiene.

ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS alg        TEXT;
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS rp_id     TEXT;
ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS sign_count BIGINT NOT NULL DEFAULT 0;
