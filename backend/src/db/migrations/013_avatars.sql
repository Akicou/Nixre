-- 013_avatars.sql — optional uploaded avatar images for users and spaces.
-- Stored as Postgres bytea (small images, self-contained — no new volume).
-- The UI falls back to initials when avatar_data is NULL.

ALTER TABLE users  ADD COLUMN IF NOT EXISTS avatar_data BYTEA;
ALTER TABLE users  ADD COLUMN IF NOT EXISTS avatar_mime TEXT;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS avatar_data BYTEA;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS avatar_mime TEXT;
