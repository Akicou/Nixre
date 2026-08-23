-- 011_personal_spaces.sql — every user gets a personal namespace ("profile").
-- On register nixre-core provisions a personal space with uid = the user's uid.
-- Repos created under /{username}/ are owned by that user and render as a
-- GitHub-style user profile at /{username}. This keeps the singular
-- space/repo machinery (spaces, space_members, git paths, ACLs) as-is.

ALTER TABLE spaces ADD COLUMN IF NOT EXISTS is_personal BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS spaces_by_created_by ON spaces(created_by);
