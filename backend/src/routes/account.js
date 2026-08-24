// Account routes — SSH public keys and personal access tokens (phase 4).
// PATs are `nxp_<identifier>_<secret>`; only sha256(token) is stored, the
// plaintext is returned exactly once at creation. Validation resolves
// through lib/auth.resolveBearer, so sessions and PATs share one path.

import express from 'express';
import crypto from 'node:crypto';
import { sha256, newPatSecret } from '../lib/auth.js';
import { encryptSecret, maskSecret } from '../lib/ai.js';

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

  // --- agent secrets (GitHub PAT, …) ------------------------------------------

  api.get('/user/secrets', auth, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT kind, key_mask FROM user_secrets WHERE user_uid = $1 ORDER BY kind',
      [req.auth.user.uid],
    );
    res.json(rows.map(r => ({
      kind: r.kind,
      configured: true,
      key_mask: r.key_mask || null,
    })));
  });

  api.put('/user/secrets/github', auth, async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (token.length < 8) {
      res.status(400).json({ message: 'Invalid token' });
      return;
    }
    const ts = Date.now();
    const mask = maskSecret(token);
    await pool.query(
      `INSERT INTO user_secrets (user_uid, kind, secret_enc, key_mask, updated)
       VALUES ($1, 'github', $2, $3, $4)
       ON CONFLICT (user_uid, kind) DO UPDATE SET secret_enc = $2, key_mask = $3, updated = $4`,
      [req.auth.user.uid, encryptSecret(token), mask, ts],
    );
    res.json({ kind: 'github', configured: true, key_mask: mask });
  });

  api.delete('/user/secrets/github', auth, async (req, res) => {
    await pool.query(
      "DELETE FROM user_secrets WHERE user_uid = $1 AND kind = 'github'",
      [req.auth.user.uid],
    );
    res.json({ ok: true });
  });

  // --- speech-to-text endpoint ------------------------------------------------

  api.get('/user/stt', auth, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT base_url, model, key_mask FROM user_stt WHERE user_uid = $1',
      [req.auth.user.uid],
    );
    const row = rows[0];
    if (!row) {
      res.json({ configured: false, base_url: null, model: null, key_mask: null });
      return;
    }
    res.json({
      configured: true,
      base_url: row.base_url,
      model: row.model,
      key_mask: row.key_mask || null,
    });
  });

  api.put('/user/stt', auth, async (req, res) => {
    const baseUrl = String(req.body?.base_url || '').trim().replace(/\/+$/, '');
    const model = String(req.body?.model || '').trim();
    const apiKey = String(req.body?.api_key || '').trim();
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      res.status(400).json({ message: 'A valid base URL is required' });
      return;
    }
    if (!model) {
      res.status(400).json({ message: 'A model id is required' });
      return;
    }
    const existing = await pool.query(
      'SELECT api_key_enc, key_mask FROM user_stt WHERE user_uid = $1',
      [req.auth.user.uid],
    );
    const prev = existing.rows[0];
    const enc = apiKey ? encryptSecret(apiKey) : (prev?.api_key_enc || null);
    const mask = apiKey ? maskSecret(apiKey) : (prev?.key_mask || null);
    const ts = Date.now();
    await pool.query(
      `INSERT INTO user_stt (user_uid, base_url, model, api_key_enc, key_mask, updated)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_uid) DO UPDATE SET
         base_url = $2, model = $3, api_key_enc = $4, key_mask = $5, updated = $6`,
      [req.auth.user.uid, baseUrl, model, enc, mask, ts],
    );
    res.json({ configured: true, base_url: baseUrl, model, key_mask: mask });
  });

  api.delete('/user/stt', auth, async (req, res) => {
    await pool.query('DELETE FROM user_stt WHERE user_uid = $1', [req.auth.user.uid]);
    res.json({ ok: true });
  });

  return api;
}
