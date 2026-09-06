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

// Sessions: opaque bearer `nxs_<secret>`. Only sha256(secret) is stored, in
// `sessions.token_hash`; the row's `id` is a separate opaque identifier so the
// token itself is never persisted. A database read therefore yields no usable
// credential — the same guarantee PATs always had.
//
// PATs: `nxp_<id>_<secret>` with only sha256(secret) stored.

export function newSessionToken() {
  return `nxs_${crypto.randomBytes(32).toString('base64url')}`;
}

/** Opaque row id for a session — never the token, never derived from it. */
export function newSessionId() {
  return crypto.randomBytes(16).toString('base64url');
}

export function newPatSecret() {
  return crypto.randomBytes(24).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Constant-time string comparison.
 *
 * Plain `===` (and `!==`) leaks how many leading bytes matched through timing,
 * which matters for anything secret-shaped: internal tokens, hashed lookups,
 * verification challenges. Compares over the sha256 digests of both sides so
 * length is also normalised away.
 */
export function timingSafeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// --- validation --------------------------------------------------------------

// Resolves an Authorization: Bearer token to { user, kind: 'session' | 'pat' }.
// Returns null when the token is unknown/expired or the user is blocked.
export async function resolveBearer(pool, token) {
  if (!token || typeof token !== 'string') return null;

  // Both lookups are by hash, so a token is never compared against a stored
  // plaintext value and a DB dump grants no usable credentials.
  const tokenHash = sha256(token);

  // Sessions: matched on token_hash, never on the token itself.
  const session = await pool.query(
    `SELECT s.id, s.expires, u.* FROM sessions s
     JOIN users u ON u.uid = s.user_uid
     WHERE s.token_hash = $1`,
    [tokenHash],
  );
  if (session.rows.length > 0) {
    const row = session.rows[0];
    if (row.blocked) return null;
    if (Number(row.expires) < Date.now()) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [row.id]);
      return null;
    }
    return { kind: 'session', user: rowToUser(row), sessionId: row.id };
  }

  // PATs: nxp_<identifier>_<secret>; identifier may contain no underscores
  // (enforced at creation), so split from the right is safe. The whole token
  // is hashed, so the identifier is not needed to look the row up.
  const pat = await pool.query(
    `SELECT t.*, u.* FROM tokens t
     JOIN users u ON u.uid = t.user_uid
     WHERE t.secret_hash = $1`,
    [tokenHash],
  );
  if (pat.rows.length > 0) {
    const row = pat.rows[0];
    if (row.blocked) return null;
    if (Number(row.expires_at) < Date.now()) return null;
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
    avatar_url: row.avatar_data ? `/api/v1/avatars/user/${row.uid}` : '',
    socials: Array.isArray(row.socials) ? row.socials : [],
    created: Number(row.created),
    updated: Number(row.updated),
  };
}
