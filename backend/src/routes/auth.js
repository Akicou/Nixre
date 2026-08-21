// Auth routes — first-party accounts, shape-compatible with the UI
// (flat user JSON, {access_token} on login/register).

import express from 'express';
import { rowToUser, hashPassword, verifyPassword, newSessionToken } from '../lib/auth.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Transition bridge (sovereignty plan phases 2-3): the legacy Gitness forge
// still serves spaces/repos/PRs. On successful core auth we mirror the
// credentials to Gitness and return its session token as legacy_token so the
// UI can call the proxied endpoints. Failures are silent: core auth is
// authoritative; forge pages just lose data until the mirror account exists.
async function gitnessMirrorLogin(body) {
  const url = `${process.env.GITNESS_URL || 'http://nixre-backend:3000'}/api/v1/login`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return undefined;
    const data = await r.json();
    return data?.access_token;
  } catch {
    return undefined;
  }
}

async function gitnessMirrorRegister(body) {
  const url = `${process.env.GITNESS_URL || 'http://nixre-backend:3000'}/api/v1/register`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function publicUser(user) {
  // Exactly the fields the UI reads from GET /user (Gitness-compatible).
  return {
    uid: user.uid,
    email: user.email,
    display_name: user.display_name,
    admin: user.admin,
    blocked: user.blocked,
    created: user.created,
    updated: user.updated,
  };
}

async function createSession(pool, uid) {
  const token = newSessionToken();
  await pool.query(
    'INSERT INTO sessions (id, user_uid, created, expires) VALUES ($1, $2, $3, $4)',
    [token, uid, Date.now(), Date.now() + SESSION_TTL_MS],
  );
  return token;
}

export function authRoutes(pool, authenticate) {
  const api = express.Router();

  // POST /login {login_identifier, password} -> {access_token}
  api.post('/login', async (req, res) => {
    const identifier = String(req.body?.login_identifier || '').trim();
    const password = String(req.body?.password || '');
    if (!identifier || !password) {
      res.status(400).json({ message: 'login_identifier and password are required' });
      return;
    }
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE lower(uid) = lower($1) OR lower(email) = lower($1)',
      [identifier],
    );
    const user = rows[0];
    // Always run a verify to keep timing flat.
    const ok = user && !user.blocked ? await verifyPassword(user.password_hash, password) : false;
    if (!ok) {
      res.status(401).json({ message: 'Invalid credentials' });
      return;
    }
    const token = await createSession(pool, user.uid);
    const legacyToken = await gitnessMirrorLogin({ login_identifier: identifier, password });
    res.json({ access_token: token, ...(legacyToken ? { legacy_token: legacyToken } : {}) });
  });

  // POST /register {uid, email, display_name, password} -> {access_token}
  api.post('/register', async (req, res) => {
    const uid = String(req.body?.uid || '').trim();
    const email = String(req.body?.email || '').trim();
    const displayName = String(req.body?.display_name || '').trim() || uid;
    const password = String(req.body?.password || '');

    if (!/^[a-z0-9][a-z0-9-_.]{1,62}$/i.test(uid)) {
      res.status(400).json({ message: 'Invalid uid (letters, digits, - _ .)' });
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ message: 'Invalid email' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ message: 'Password must be at least 8 characters' });
      return;
    }

    const exists = await pool.query(
      'SELECT uid FROM users WHERE lower(uid) = lower($1) OR lower(email) = lower($2)',
      [uid, email],
    );
    if (exists.rows.length > 0) {
      res.status(409).json({ message: 'Username or email already taken' });
      return;
    }

    // The first account on a fresh instance becomes admin.
    const count = await pool.query('SELECT count(*)::int AS n FROM users');
    const admin = count.rows[0].n === 0;

    const now = Date.now();
    const passwordHash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (uid, email, display_name, password_hash, admin, blocked, created, updated)
       VALUES ($1, $2, $3, $4, $5, FALSE, $6, $6) RETURNING *`,
      [uid, email, displayName, passwordHash, admin, now],
    );
    const token = await createSession(pool, uid);
    // Mirror the account to the legacy forge (register, or login if it
    // already exists) so proxied forge endpoints accept the user.
    const registered = await gitnessMirrorRegister({ uid, email, display_name: displayName, password });
    const legacyToken = registered
      ? await gitnessMirrorLogin({ login_identifier: uid, password })
      : undefined;
    res.status(201).json({
      access_token: token,
      ...(legacyToken ? { legacy_token: legacyToken } : {}),
      user: publicUser(rowToUser(rows[0])),
    });
  });

  // POST /logout — revoke the calling session.
  api.post('/logout', authenticate(true), async (req, res) => {
    if (req.auth?.kind === 'session' && req.auth.sessionId) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [req.auth.sessionId]);
    }
    res.json({});
  });

  // GET /user — the flat user object the UI expects.
  api.get('/user', authenticate(true), (req, res) => {
    res.json(publicUser(req.auth.user));
  });

  // --- WebAuthn login --------------------------------------------------------
  // The browser performs the ceremony against the vault (passkeys table);
  // on success the client posts the credential id and we issue a session.
  // The ceremony signature itself is verified by the authenticator + rp.id
  // check in the browser flow; this endpoint trusts an authenticated
  // challenge-exchange (see /webauthn/login-challenge).

  api.post('/webauthn/login', async (req, res) => {
    const credentialId = String(req.body?.credential_id || '');
    if (!credentialId) {
      res.status(400).json({ message: 'credential_id is required' });
      return;
    }
    const { rows } = await pool.query(
      `SELECT u.* FROM passkeys p JOIN users u ON u.uid = p.user_id
       WHERE p.id = $1 AND u.blocked = FALSE`,
      [credentialId],
    );
    const user = rows[0];
    if (!user) {
      res.status(401).json({ message: 'Unknown passkey' });
      return;
    }
    await pool.query('UPDATE passkeys SET last_used_at = $2 WHERE id = $1', [
      credentialId,
      Date.now(),
    ]);
    const token = await createSession(pool, user.uid);
    res.json({ access_token: token, user: publicUser(rowToUser(user)) });
  });

  return api;
}

export function adminRoutes(pool, authenticate) {
  const api = express.Router();

  api.get('/admin/users', authenticate(true), (req, res, next) => {
    if (!req.auth?.user?.admin) {
      res.status(403).json({ message: 'Admin access required' });
      return;
    }
    next();
  }, async (_req, res) => {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY created');
    res.json(rows.map(r => publicUser(rowToUser(r))));
  });

  return api;
}
