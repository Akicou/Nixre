-- 001_core_auth.sql — first-party auth: users, sessions, tokens.
-- Applied idempotently by src/db/migrate.js on boot.

CREATE TABLE IF NOT EXISTS users (
  uid            TEXT PRIMARY KEY,          -- 'testuser'
  email          TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,             -- argon2id
  admin          BOOLEAN NOT NULL DEFAULT FALSE,
  blocked        BOOLEAN NOT NULL DEFAULT FALSE,
  created        BIGINT NOT NULL,
  updated        BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_by_email ON users (email);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,             -- opaque token id
  user_uid    TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  created     BIGINT NOT NULL,
  expires     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_uid);

-- Personal access tokens (distinct from sessions; same validation path).
CREATE TABLE IF NOT EXISTS tokens (
  id          TEXT PRIMARY KEY,             -- identifier (user-chosen slug)
  user_uid    TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL,                -- sha256 of the secret half
  issued_at   BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL
);
