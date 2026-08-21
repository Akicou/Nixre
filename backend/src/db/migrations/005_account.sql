-- 005_account.sql — SSH public keys (phase 4).
-- Personal access tokens already live in the 001 tokens table.

CREATE TABLE IF NOT EXISTS public_keys (
  identifier  TEXT NOT NULL,             -- user-chosen label, unique per user
  user_uid    TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  content     TEXT NOT NULL,             -- the ssh key line (type base64 comment)
  fingerprint TEXT NOT NULL,             -- sha256 fingerprint of the key
  created     BIGINT NOT NULL,
  updated     BIGINT NOT NULL,
  PRIMARY KEY (user_uid, identifier)
);
