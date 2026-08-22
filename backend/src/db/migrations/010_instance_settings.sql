-- 010_instance_settings.sql — instance-wide settings (admin-managed).
--
-- registration_closed is the durable source of truth for the signup kill
-- switch; NIXRE_REGISTRATION_CLOSED=true in the environment still forces it
-- closed (boot-time override for deploy scripts), but the admin UI toggles
-- this row and the running core picks it up without a restart.

CREATE TABLE IF NOT EXISTS instance_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);
