// Instance-wide settings — small key/value state the admin console owns.
//
// `registrationClosed` drives the signup kill switch: the register route
// consults it per request, the admin API mutates it live, and it persists in
// the instance_settings table so container restarts keep the state.
//
// NIXRE_REGISTRATION_CLOSED from the environment is only the initial default
// (used before an admin ever toggles it — deploy scripts like
// no-more-register.sh rely on it). Once the row exists, the DB value is the
// single source of truth so the admin UI can always override.

import { pool } from '../db/pool.js';

let registrationClosed = false;
let loaded = false;

function envDefaultClosed() {
  return String(process.env.NIXRE_REGISTRATION_CLOSED || '').toLowerCase() === 'true';
}

export async function loadInstanceSettings() {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM instance_settings WHERE key = 'registration_closed'",
    );
    registrationClosed = rows.length > 0 ? rows[0].value === 'true' : envDefaultClosed();
  } catch {
    registrationClosed = envDefaultClosed(); // table not migrated yet
  }
  loaded = true;
  return { registrationClosed };
}

export function isRegistrationClosed() {
  return loaded ? registrationClosed : envDefaultClosed();
}

export async function setRegistrationClosed(closed) {
  registrationClosed = Boolean(closed);
  await pool.query(
    `INSERT INTO instance_settings (key, value, updated_at)
     VALUES ('registration_closed', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [registrationClosed ? 'true' : 'false', Date.now()],
  );
  return registrationClosed;
}
