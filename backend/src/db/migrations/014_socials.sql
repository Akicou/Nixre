-- 014_socials.sql — user social links (shown on the public profile / goals).
-- Stored as a JSONB array of { platform, url } pairs, e.g.
--   [{"platform":"github","url":"https://github.com/lyan"},...]

ALTER TABLE users ADD COLUMN IF NOT EXISTS socials JSONB NOT NULL DEFAULT '[]'::jsonb;
