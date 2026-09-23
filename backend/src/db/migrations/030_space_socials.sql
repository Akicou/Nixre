-- 030_space_socials.sql — organization social links, the space-level twin of
-- 014_socials.sql. SpaceView has rendered a social list for organizations
-- since it was written, but there was nowhere to store one.
--
-- Same shape as users.socials: a JSONB array of { platform, url } pairs.

ALTER TABLE spaces ADD COLUMN IF NOT EXISTS socials JSONB NOT NULL DEFAULT '[]'::jsonb;
