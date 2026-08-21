// Account routes — SSH public keys and personal access tokens (phase 4).
// PATs are `nxp_<identifier>_<secret>`; only sha256(token) is stored, the
// plaintext is returned exactly once at creation. Validation resolves
// through lib/auth.resolveBearer, so sessions and PATs share one path.

import express from 'express';
import crypto from 'node:crypto';
import { sha256, newPatSecret } from '../lib/auth.js';

function fingerprintKey(content) {
  // ssh key line: "<type> <base64> [comment]"
  const parts = String(content).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const raw = Buffer.from(parts[1], 'base64');
  if (raw.length === 0) return null;
  return `SHA256:${crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`;
}

export function accountRoutes(pool, authenticate) {
  const api = express.Router();
  const auth = authenticate(true);

  // --- SSH public keys ---------------------------------------------------------

  api.get('/user/publickeys', auth, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM public_keys WHERE user_uid = $1 ORDER BY created',
      [req.auth.user.uid],
    );
    res.json({
      keys: rows.map(r => ({
        identifier: r.identifier,
        content: r.content,
        fingerprint: r.fingerprint,
        created: Number(r.created),
        updated: Number(r.updated),
      })),
    });
  });

  api.post('/user/publickeys', auth, async (req, res) => {
    const identifier = String(req.body?.identifier || '').trim();
    const content = String(req.body?.content || '').trim();
    if (!/^[a-z0-9][a-z0-9-_.]{0,63}$/i.test(identifier)) {
      res.status(400).json({ message: 'Invalid identifier' });
      return;
    }
    const fingerprint = fingerprintKey(content);
    if (!fingerprint) {
      res.status(400).json({ message: 'Invalid SSH public key' });
      return;
    }
    const dup = await pool.query(
      'SELECT identifier FROM public_keys WHERE user_uid = $1 AND identifier = $2',
      [req.auth.user.uid, identifier],
    );
    if (dup.rows.length > 0) {
      res.status(409).json({ message: 'Key identifier already used' });
      return;
    }
    const ts = Date.now();
    await pool.query(
      'INSERT INTO public_keys (identifier, user_uid, content, fingerprint, created, updated) VALUES ($1, $2, $3, $4, $5, $5)',
      [identifier, req.auth.user.uid, content, fingerprint, ts],
    );
    res.status(201).json({ identifier, content, fingerprint, created: ts, updated: ts });
  });

  api.delete('/user/publickeys/:identifier', auth, async (req, res) => {
    await pool.query('DELETE FROM public_keys WHERE user_uid = $1 AND identifier = $2', [
      req.auth.user.uid,
      req.params.identifier,
    ]);
    res.json({});
  });

  // --- personal access tokens -----------------------------------------------------

  // Minted token: nxp_<identifier>_<secret>. The identifier must not contain
  // underscores so the split in resolveBearer stays unambiguous.
  api.get('/user/tokens', auth, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id, issued_at, expires_at FROM tokens WHERE user_uid = $1 ORDER BY issued_at',
      [req.auth.user.uid],
    );
    res.json({
      tokens: rows.map(r => ({
        identifier: r.id,
        type: 'pat',
        issued_at: Number(r.issued_at),
        expires_at: Number(r.expires_at),
      })),
    });
  });

  api.post('/user/tokens', auth, async (req, res) => {
    const identifier = String(req.body?.identifier || '').trim();
    const lifetime = Number(req.body?.lifetime) || 30 * 24 * 60 * 60 * 1000;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(identifier)) {
      res.status(400).json({ message: 'Invalid identifier (letters, digits, dashes)' });
      return;
    }
    const dup = await pool.query('SELECT id FROM tokens WHERE user_uid = $1 AND id = $2', [
      req.auth.user.uid,
      identifier,
    ]);
    if (dup.rows.length > 0) {
      res.status(409).json({ message: 'Token identifier already used' });
      return;
    }
    const secret = newPatSecret();
    const token = `nxp_${identifier}_${secret}`;
    const ts = Date.now();
    await pool.query(
      'INSERT INTO tokens (id, user_uid, secret_hash, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [identifier, req.auth.user.uid, sha256(token), ts, ts + lifetime],
    );
    res.status(201).json({
      access_token: token,
      token: { identifier, type: 'pat', issued_at: ts, expires_at: ts + lifetime },
    });
  });

  api.delete('/user/tokens/:identifier', auth, async (req, res) => {
    await pool.query('DELETE FROM tokens WHERE user_uid = $1 AND id = $2', [
      req.auth.user.uid,
      req.params.identifier,
    ]);
    res.json({});
  });

  return api;
}
