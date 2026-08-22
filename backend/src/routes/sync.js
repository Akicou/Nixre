// Sync routes — account-scoped UI state, absorbed from the standalone
// nixre-sync service. Authentication is first-party: the middleware has
// already resolved req.auth.user from the bearer token.

import express from 'express';

const nowMs = () => Date.now();

function rowToConversation(row) {
  return {
    id: row.id,
    repoPath: row.repo_path,
    title: row.title,
    messages: row.messages,
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

function rowToPasskey(row) {
  return {
    id: row.id,
    name: row.name,
    userUid: row.user_uid,
    userEmail: row.user_email,
    publicKey: row.public_key,
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at == null ? undefined : Number(row.last_used_at),
  };
}

export function syncRoutes(pool, authenticate) {
  const api = express.Router();

  const uid = req => req.auth.user.uid;
  const auth = authenticate(true);

  // --- prefs ------------------------------------------------------------------

  api.get('/prefs', auth, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT key, value FROM prefs WHERE user_id = $1',
      [uid(req)],
    );
    const out = {};
    for (const row of rows) out[row.key] = row.value;
    res.json(out);
  });

  api.put('/prefs/:key', auth, async (req, res) => {
    const key = req.params.key;
    if (!/^[a-z0-9_.:-]{1,128}$/i.test(key)) {
      res.status(400).json({ message: 'Invalid prefs key' });
      return;
    }
    const value = req.body?.value;
    if (value === undefined) {
      res.status(400).json({ message: 'Body must be { "value": ... }' });
      return;
    }
    await pool.query(
      `INSERT INTO prefs (user_id, key, value, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (user_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [uid(req), key, JSON.stringify(value)],
    );
    res.json({ key, value });
  });

  api.delete('/prefs/:key', auth, async (req, res) => {
    await pool.query('DELETE FROM prefs WHERE user_id = $1 AND key = $2', [
      uid(req),
      req.params.key,
    ]);
    res.json({ ok: true });
  });

  // --- conversations ------------------------------------------------------------

  api.get('/conversations', auth, async (req, res) => {
    const repo = typeof req.query.repo === 'string' ? req.query.repo : null;
    const { rows } = await pool.query(
      `SELECT * FROM conversations
       WHERE user_id = $1 AND ($2::text IS NULL OR repo_path = $2)
       ORDER BY updated_at DESC`,
      [uid(req), repo],
    );
    res.json(rows.map(rowToConversation));
  });

  api.get('/conversations/:id', auth, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM conversations WHERE user_id = $1 AND id = $2',
      [uid(req), req.params.id],
    );
    if (rows.length === 0) {
      res.status(404).json({ message: 'Conversation not found' });
      return;
    }
    res.json(rowToConversation(rows[0]));
  });

  api.post('/conversations', auth, async (req, res) => {
    const repoPath = String(req.body?.repoPath || '');
    if (!repoPath) {
      res.status(400).json({ message: 'repoPath is required' });
      return;
    }
    const id = `conv_${nowMs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const title = String(req.body?.title || 'Untitled').slice(0, 128);
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const { rows } = await pool.query(
      `INSERT INTO conversations (id, user_id, repo_path, title, messages)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING *`,
      [id, uid(req), repoPath, title, JSON.stringify(messages)],
    );
    res.status(201).json(rowToConversation(rows[0]));
  });

  api.put('/conversations/:id', auth, async (req, res) => {
    const values = [];
    const updates = [];
    if (req.body?.title !== undefined) {
      values.push(String(req.body.title).slice(0, 128));
      updates.push(`title = $${values.length}`);
    }
    if (req.body?.messages !== undefined) {
      if (!Array.isArray(req.body.messages)) {
        res.status(400).json({ message: 'messages must be an array' });
        return;
      }
      values.push(JSON.stringify(req.body.messages));
      updates.push(`messages = $${values.length}::jsonb`);
    }
    if (updates.length === 0) {
      res.status(400).json({ message: 'Nothing to update' });
      return;
    }
    const setSql = updates.join(', ');
    const { rows } = await pool.query(
      `UPDATE conversations SET ${setSql}, updated_at = now()
       WHERE user_id = $${values.length + 1} AND id = $${values.length + 2} RETURNING *`,
      [...values, uid(req), req.params.id],
    );
    if (rows.length === 0) {
      res.status(404).json({ message: 'Conversation not found' });
      return;
    }
    res.json(rowToConversation(rows[0]));
  });

  api.delete('/conversations/:id', auth, async (req, res) => {
    await pool.query('DELETE FROM conversations WHERE user_id = $1 AND id = $2', [
      uid(req),
      req.params.id,
    ]);
    res.json({ ok: true });
  });

  // --- passkeys -------------------------------------------------------------------

  api.get('/passkeys', auth, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM passkeys WHERE user_id = $1 ORDER BY created_at DESC',
      [uid(req)],
    );
    res.json(rows.map(rowToPasskey));
  });

  api.post('/passkeys', auth, async (req, res) => {
    const b = req.body || {};
    const id = String(b.id || '');
    const name = String(b.name || 'Passkey').slice(0, 128);
    const userUid = String(b.userUid || req.auth.user.uid);
    const userEmail = String(b.userEmail || '');
    // Optional WebAuthn material (current UI): COSE public key + alg + the
    // rpId the credential was created for. Without a public key the entry is
    // vault metadata only and cannot be used for passkey login.
    const publicKey = b.publicKey ? String(b.publicKey).slice(0, 4096) : null;
    const alg = b.alg ? String(b.alg).slice(0, 16) : null;
    const rpId = b.rpId ? String(b.rpId).slice(0, 255) : null;
    if (!id) {
      res.status(400).json({ message: 'id is required' });
      return;
    }
    const { rows } = await pool.query(
      `INSERT INTO passkeys (id, user_id, name, user_uid, user_email, public_key, alg, rp_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         public_key = COALESCE(EXCLUDED.public_key, passkeys.public_key),
         alg = COALESCE(EXCLUDED.alg, passkeys.alg),
         rp_id = COALESCE(EXCLUDED.rp_id, passkeys.rp_id)
       RETURNING *`,
      [id, uid(req), name, userUid, userEmail, publicKey, alg, rpId, nowMs()],
    );
    res.status(201).json(rowToPasskey(rows[0]));
  });

  api.put('/passkeys/:id/last-used', auth, async (req, res) => {
    const { rows } = await pool.query(
      'UPDATE passkeys SET last_used_at = $3 WHERE user_id = $1 AND id = $2 RETURNING *',
      [uid(req), req.params.id, nowMs()],
    );
    if (rows.length === 0) {
      res.status(404).json({ message: 'Passkey not found' });
      return;
    }
    res.json(rowToPasskey(rows[0]));
  });

  api.delete('/passkeys/:id', auth, async (req, res) => {
    await pool.query('DELETE FROM passkeys WHERE user_id = $1 AND id = $2', [
      uid(req),
      req.params.id,
    ]);
    res.json({ ok: true });
  });

  return api;
}
