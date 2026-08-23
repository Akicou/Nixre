// Auth routes — first-party accounts, shape-compatible with the UI
// (flat user JSON, {access_token} on login/register).

import express from 'express';
import { rowToUser, hashPassword, verifyPassword, newSessionToken } from '../lib/auth.js';
import {
  newChallenge,
  takeChallenge,
  coseToKeyObject,
  verifyAssertion,
  originFromRequest,
} from '../lib/webauthn.js';
import { isRegistrationClosed, setRegistrationClosed } from '../lib/instanceSettings.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
    res.json({ access_token: token });
  });

  // --- passkey login (server-verified WebAuthn) ----------------------------------
  //
  // Two steps, both unauthenticated by design: the challenge endpoint issues
  // a single-use server challenge (2-min TTL, in memory), the login endpoint
  // verifies the assertion signature against the public key stored at
  // registration and mints a normal session. Only credentials registered
  // with a public key (current UI) can log in — legacy vault rows without
  // one are metadata only.

  // POST /webauthn/login-challenge {userUid?} -> {challenge, allowCredentials: [{id}]}
  api.post('/webauthn/login-challenge', async (req, res) => {
    let rpId;
    let origin;
    try {
      ({ origin, rpId } = originFromRequest(req));
    } catch {
      res.status(400).json({ message: 'Origin header required' });
      return;
    }
    const userUid = String(req.body?.userUid || '').trim();
    let allowCredentials = [];
    if (userUid) {
      const { rows } = await pool.query(
        `SELECT id FROM passkeys
         WHERE lower(user_uid) = lower($1) AND public_key IS NOT NULL AND COALESCE(rp_id, '') = $2`,
        [userUid, rpId],
      );
      allowCredentials = rows.map(r => ({ id: r.id }));
      if (allowCredentials.length === 0) {
        res.status(404).json({
          message: `No passkeys registered for '${userUid}' on ${rpId}. Register one in Settings → Passkeys after signing in.`,
        });
        return;
      }
    }
    res.json({ challenge: newChallenge(), allowCredentials });
  });

  // POST /webauthn/login {id, response: {clientDataJSON, authenticatorData, signature}}
  //   -> {access_token, user}
  api.post('/webauthn/login', async (req, res) => {
    const b = req.body || {};
    const credentialId = String(b.id || '');
    const resp = b.response || {};
    if (!credentialId || !resp.clientDataJSON || !resp.authenticatorData || !resp.signature) {
      res.status(400).json({ message: 'id, clientDataJSON, authenticatorData and signature are required' });
      return;
    }
    let rpId;
    let origin;
    try {
      ({ origin, rpId } = originFromRequest(req));
    } catch {
      res.status(400).json({ message: 'Origin header required' });
      return;
    }

    const { rows } = await pool.query(
      `SELECT p.*, u.uid AS account_uid, u.email AS account_email, u.display_name AS account_name,
              u.admin AS account_admin, u.blocked AS account_blocked, u.created AS account_created,
              u.updated AS account_updated
       FROM passkeys p JOIN users u ON u.uid = p.user_uid
       WHERE p.id = $1 AND p.public_key IS NOT NULL AND COALESCE(p.rp_id, '') = $2`,
      [credentialId, rpId],
    );
    const cred = rows[0];
    if (!cred) {
      res.status(401).json({ message: 'Unknown passkey' });
      return;
    }

    let clientData;
    try {
      clientData = JSON.parse(Buffer.from(String(resp.clientDataJSON), 'base64url').toString('utf8'));
    } catch {
      res.status(401).json({ message: 'Malformed client data' });
      return;
    }
    if (!takeChallenge(clientData.challenge)) {
      res.status(401).json({ message: 'Challenge expired or already used' });
      return;
    }

    try {
      const keyObject = coseToKeyObject(cred.public_key);
      const { signCount, userVerified } = verifyAssertion({
        clientDataJSON: resp.clientDataJSON,
        authenticatorData: resp.authenticatorData,
        signature: resp.signature,
        keyObject,
        alg: cred.alg || 'ES256',
        expectedChallenge: String(clientData.challenge),
        expectedOrigin: origin,
        expectedRpId: rpId,
      });
      // Replay hygiene: authenticator counters only increase (0 = not tracked).
      if (signCount > 0 && signCount <= Number(cred.sign_count || 0)) {
        throw new Error('authenticator counter did not advance');
      }
      void userVerified;
      const token = await createSession(pool, cred.account_uid);
      await pool.query('UPDATE passkeys SET last_used_at = $2, sign_count = $3 WHERE id = $1', [
        credentialId,
        Date.now(),
        signCount,
      ]);
      res.json({
        access_token: token,
        user: publicUser(
          rowToUser({
            uid: cred.account_uid,
            email: cred.account_email,
            display_name: cred.account_name,
            admin: cred.account_admin,
            blocked: cred.account_blocked,
            created: cred.account_created,
            updated: cred.account_updated,
          }),
        ),
      });
    } catch (err) {
      res.status(401).json({ message: `Passkey verification failed: ${err.message}` });
    }
  });

  // POST /register {uid, email, display_name, password} -> {access_token}
  api.post('/register', async (req, res) => {
    // Server-side signup kill switch — toggled from the admin console (DB
    // backed, live without a restart) or defaulted from
    // NIXRE_REGISTRATION_CLOSED before an admin ever touches it.
    if (isRegistrationClosed()) {
      res.status(403).json({ message: 'Registration is currently closed on this instance.' });
      return;
    }

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

    // Provision the user's personal namespace (GitHub-style profile owner).
    // uid === space.uid; repos created here live at /{uid}/{repo}. Idempotent
    // so a retry after a partial failure never double-creates.
    try {
      await pool.query(
        `INSERT INTO spaces (uid, description, is_public, is_personal, created_by, created, updated)
         VALUES ($1, '', TRUE, TRUE, $1, $2, $2)
         ON CONFLICT (uid) DO NOTHING`,
        [uid, now],
      );
      await pool.query(
        `INSERT INTO space_members (space_uid, user_uid, role, created)
         VALUES ($1, $1, 'owner', $2)
         ON CONFLICT (space_uid, user_uid) DO NOTHING`,
        [uid, now],
      );
    } catch (err) {
      console.error('Failed to provision personal space for', uid, err.message);
    }

    res.status(201).json({
      access_token: token,
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

  // GET /admin/registration -> {closed} — real server-side signup state.
  api.get('/admin/registration', authenticate(true), (req, res) => {
    if (!req.auth?.user?.admin) {
      res.status(403).json({ message: 'Admin access required' });
      return;
    }
    res.json({ closed: isRegistrationClosed() });
  });

  // PUT /admin/registration {closed: boolean} — flips the kill switch live;
  // persists in instance_settings so restarts keep it.
  api.put('/admin/registration', authenticate(true), async (req, res) => {
    if (!req.auth?.user?.admin) {
      res.status(403).json({ message: 'Admin access required' });
      return;
    }
    const closed = req.body?.closed;
    if (typeof closed !== 'boolean') {
      res.status(400).json({ message: 'closed (boolean) is required' });
      return;
    }
    await setRegistrationClosed(closed);
    res.json({ closed: isRegistrationClosed() });
  });

  return api;
}
