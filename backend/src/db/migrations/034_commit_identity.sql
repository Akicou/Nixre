-- 034_commit_identity.sql — who a commit belongs to.
--
-- Git authorship is whatever the client puts in user.name / user.email, so the
-- only reliable link from a commit to an account is an email the account has
-- claimed. `user_emails` lets one account own several (first claim wins, the
-- primary key is the lowercased address). `push_events` records who actually
-- pushed (server-authenticated), so "Active" can count people, not name
-- spellings.

CREATE TABLE IF NOT EXISTS user_emails (
  email    TEXT PRIMARY KEY CHECK (email = lower(email)),
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  created  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS user_emails_user_idx ON user_emails (user_uid);

CREATE TABLE IF NOT EXISTS push_events (
  id       BIGSERIAL PRIMARY KEY,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  space    TEXT NOT NULL,
  repo     TEXT NOT NULL,
  created  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_events_created_idx ON push_events (created);
