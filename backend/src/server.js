// Nixre Sync Ã¢â‚¬â€ backend persistence for account-scoped UI state.
//
// Gitness exposes no user-preferences API (only user info, SSH keys,
// memberships, tokens), so Nixre ships this small companion service.
// Authentication is delegated to Gitness: every request must carry the
// Gitness Bearer token, which we validate against Gitness /api/v1/user.
// The resolved Gitness user id scopes every query.
//
// Data owned by this service:
//   prefs          - plugin toggles, plugin configs, assistant profiles
//   conversations  - assistant chat sessions
//   passkeys       - WebAuthn credential metadata (the vault listing)

import express from 'express';
import pg from 'pg';

const PORT = Number(process.env.PORT || 3002);
const GITNESS_URL = process.env.GITNESS_URL || 'http://nixre-backend:3000';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://nixre:nixre@localhost:5432/nixre';

const pool = new pg.Pool({ connectionString: DATABASE_URL });

// ---------------------------------------------------------------------------
// Schema (idempotent, applied on boot)
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prefs (
  user_id    TEXT         NOT NULL,
  key        TEXT         NOT NULL,
  value      JSONB        NOT NULL,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT         NOT NULL,
  user_id    TEXT         NOT NULL,
  repo_path  TEXT         NOT NULL,
  title      TEXT         NOT NULL DEFAULT 'Untitled',
  messages   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS conversations_by_repo
  ON conversations (user_id, repo_path, updated_at DESC);
CREATE TABLE IF NOT EXISTS passkeys (
  id           TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  user_uid     TEXT    NOT NULL,
  user_email   TEXT    NOT NULL DEFAULT '',
  public_key   TEXT,
  created_at   BIGINT  NOT NULL,
  last_used_at BIGINT,
  PRIMARY KEY (id)
);
`;

// ---------------------------------------------------------------------------
// Auth: validate the Gitness session token
// ---------------------------------------------------------------------------

async function authenticate(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Missing bearer token' });
    return;
  }
  try {
    const r = await fetch(`${GITNESS_URL}/api/v1/user`, {
      headers: { Authorization: auth },
    });
    if (!r.ok) {
      res.status(401).json({ message: 'Invalid or expired token' });
      return;
    }
    const user = await r.json();
    if (typeof user?.uid !== 'string' || user.uid.length === 0) {
      res.status(401).json({ message: 'Unexpected user payload' });
      return;
    }
    req.gitnessUser = user;
    next();
  } catch {
    res.status(502).json({ message: 'Cannot reach Gitness to validate the token' });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nowMs = () => Date.now();

function conversationId() {
  return `conv_${nowMs().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

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

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '4mb' }));

// Health check (no auth) for container orchestration.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const api = express.Router();
api.use(authenticate);

// --- prefs ------------------------------------------------------------------

api.get('/prefs', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT key, value FROM prefs WHERE user_id = $1',
    [req.gitnessUser.uid],
  );
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  res.json(out);
});

api.put('/prefs/:key', async (req, res) => {
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
    [req.gitnessUser.uid, key, JSON.stringify(value)],
  );
  res.json({ key, value });
});

api.delete('/prefs/:key', async (req, res) => {
  await pool.query('DELETE FROM prefs WHERE user_id = $1 AND key = $2', [
    req.gitnessUser.uid,
    req.params.key,
  ]);
  res.json({ ok: true });
});

// --- conversations ----------------------------------------------------------

api.get('/conversations', async (req, res) => {
  const repo = typeof req.query.repo === 'string' ? req.query.repo : null;
  const { rows } = await pool.query(
    `SELECT * FROM conversations
     WHERE user_id = $1 AND ($2::text IS NULL OR repo_path = $2)
     ORDER BY updated_at DESC`,
    [req.gitnessUser.uid, repo],
  );
  res.json(rows.map(rowToConversation));
});

api.get('/conversations/:id', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM conversations WHERE user_id = $1 AND id = $2',
    [req.gitnessUser.uid, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ message: 'Conversation not found' });
    return;
  }
  res.json(rowToConversation(rows[0]));
});

api.post('/conversations', async (req, res) => {
  const repoPath = String(req.body?.repoPath || '');
  if (!repoPath) {
    res.status(400).json({ message: 'repoPath is required' });
    return;
  }
  const id = typeof req.body?.id === 'string' && req.body.id ? req.body.id : conversationId();
  const title = String(req.body?.title || 'Untitled').slice(0, 128);
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const { rows } = await pool.query(
    `INSERT INTO conversations (id, user_id, repo_path, title, messages)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, updated_at = now()
     RETURNING *`,
    [id, req.gitnessUser.uid, repoPath, title, JSON.stringify(messages)],
  );
  res.status(201).json(rowToConversation(rows[0]));
});

api.put('/conversations/:id', async (req, res) => {
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
    [...values, req.gitnessUser.uid, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ message: 'Conversation not found' });
    return;
  }
  res.json(rowToConversation(rows[0]));
});

api.delete('/conversations/:id', async (req, res) => {
  await pool.query('DELETE FROM conversations WHERE user_id = $1 AND id = $2', [
    req.gitnessUser.uid,
    req.params.id,
  ]);
  res.json({ ok: true });
});

// --- passkeys ---------------------------------------------------------------

api.get('/passkeys', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM passkeys WHERE user_id = $1 ORDER BY created_at DESC',
    [req.gitnessUser.uid],
  );
  res.json(rows.map(rowToPasskey));
});

api.post('/passkeys', async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '');
  const name = String(b.name || 'Passkey').slice(0, 128);
  const userUid = String(b.userUid || req.gitnessUser.uid);
  const userEmail = String(b.userEmail || '');
  if (!id) {
    res.status(400).json({ message: 'id is required' });
    return;
  }
  const { rows } = await pool.query(
    `INSERT INTO passkeys (id, user_id, name, user_uid, user_email, public_key, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [id, req.gitnessUser.uid, name, userUid, userEmail, b.publicKey ?? null, nowMs()],
  );
  res.status(201).json(rowToPasskey(rows[0]));
});

api.put('/passkeys/:id/last-used', async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE passkeys SET last_used_at = $3 WHERE user_id = $1 AND id = $2 RETURNING *',
    [req.gitnessUser.uid, req.params.id, nowMs()],
  );
  if (rows.length === 0) {
    res.status(404).json({ message: 'Passkey not found' });
    return;
  }
  res.json(rowToPasskey(rows[0]));
});

api.delete('/passkeys/:id', async (req, res) => {
  await pool.query('DELETE FROM passkeys WHERE user_id = $1 AND id = $2', [
    req.gitnessUser.uid,
    req.params.id,
  ]);
  res.json({ ok: true });
});

app.use('/api/sync/v1', api);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: 'Internal sync service error' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  let retries = 30;
  while (retries-- > 0) {
    try {
      const client = await pool.connect();
      await client.query(SCHEMA);
      client.release();
      break;
    } catch (err) {
      if (retries === 0) throw err;
      console.log('Database not ready, retrying...');
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  app.listen(PORT, () => {
    console.log(`nixre-sync listening on :${PORT} (gitness at ${GITNESS_URL})`);
  });
}

boot().catch(err => {
  console.error('Failed to start nixre-sync:', err);
  process.exit(1);
});
