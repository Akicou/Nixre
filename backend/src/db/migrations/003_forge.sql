-- 003_forge.sql — spaces and repos (phase 2 of the sovereignty plan).
-- Git objects live on disk (/data/repos/{space}/{repo}.git); Postgres holds
-- metadata only, the same split Gitea/GitLab use.

CREATE TABLE IF NOT EXISTS spaces (
  uid         TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  is_public   BOOLEAN NOT NULL DEFAULT FALSE,
  created_by  TEXT NOT NULL REFERENCES users(uid),
  created     BIGINT NOT NULL,
  updated     BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS space_members (
  space_uid TEXT NOT NULL REFERENCES spaces(uid) ON DELETE CASCADE,
  user_uid  TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member', -- owner | member
  created   BIGINT NOT NULL,
  PRIMARY KEY (space_uid, user_uid)
);

CREATE TABLE IF NOT EXISTS repos (
  id             BIGSERIAL PRIMARY KEY,
  space_uid      TEXT NOT NULL REFERENCES spaces(uid) ON DELETE CASCADE,
  uid            TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  is_public      BOOLEAN NOT NULL DEFAULT TRUE,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_by     TEXT NOT NULL REFERENCES users(uid),
  created        BIGINT NOT NULL,
  updated        BIGINT NOT NULL,
  UNIQUE (space_uid, uid)
);
