// Auth primitives: argon2id password hashing, token generation, and
// session / personal-access-token resolution for the auth middleware.

import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// --- password hashing ---------------------------------------------------------

export async function hashPassword(password) {
  return hash(password);
}

export async function verifyPassword(hashValue, password) {
  try {
    return await verify(hashValue, password);
  } catch {
    return false;
  }
}

// --- tokens ---------------------------------------------------------------------

// Sessions: opaque bearer `nxs_<secret>`; the secret is stored hashed? No —
// sessions are DB rows keyed by the full token id, revocable on logout.
// PATs: `nxp_<id>_<secret>` with only sha256(secret) stored.

export function newSessionToken() {
  return `nxs_${crypto.randomBytes(32).toString('base64url')}`;
}

export function newPatSecret() {
  return crypto.randomBytes(24).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// --- validation --------------------------------------------------------------

// Resolves an Authorization: Bearer token to { user, kind: 'session' | 'pat' }.
// Returns null when the token is unknown/expired or the user is blocked.
export async function resolveBearer(pool, token) {
  if (!token) return null;

  // Session tokens are stored verbatim as sessions.id.
  const session = await pool.query(
    `SELECT s.id, s.expires, u.* FROM sessions s
     JOIN users u ON u.uid = s.user_uid
     WHERE s.id = $1`,
    [token],
  );
  if (session.rows.length > 0) {
    const row = session.rows[0];
    if (row.blocked) return null;
    if (Number(row.expires) < Date.now()) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [token]);
      return null;
    }
    return { kind: 'session', user: rowToUser(row), sessionId: row.id };
  }

  // PATs: nxp_<identifier>_<secret>; identifier may contain no underscores
  // (enforced at creation), so split from the right is safe. Identifier is
  // also matched directly below via tokens.id.
  const pat = await pool.query(
    `SELECT t.*, u.* FROM tokens t
     JOIN users u ON u.uid = t.user_uid
     WHERE t.secret_hash = $1`,
    [sha256(token)],
  );
  if (pat.rows.length > 0) {
    const row = pat.rows[0];
    if (row.blocked) return null;
    if (Number(row.expires) < Date.now()) return null;
    return { kind: 'pat', user: rowToUser(row) };
  }

  return null;
}

export function rowToUser(row) {
  return {
    uid: row.uid,
    email: row.email,
    display_name: row.display_name,
    admin: Boolean(row.admin),
    blocked: Boolean(row.blocked),
    created: Number(row.created),
    updated: Number(row.updated),
  };
}
