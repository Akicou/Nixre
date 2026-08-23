// Avatar routes — optional profile images for users and spaces.
// Stored as Postgres bytea (small, self-contained). Upload is authenticated;
// serving is public (an <img> tag can't send a Bearer token, and avatars are
// already exposed on public profiles / commit rows).

import express from 'express';

const ALLOWED_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);
const MAX_BYTES = 2 * 1024 * 1024;

// Accept either a bare base64 `data` string with a `mime`, or a full data URL.
function decodeAvatar(data, mime) {
  const normMime = String(mime || '').toLowerCase();
  if (!ALLOWED_MIME.has(normMime)) return null;
  if (!data || typeof data !== 'string') return null;
  const base64 = data.replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0 || buf.length > MAX_BYTES) return null;
  return { buf, mime: normMime };
}

function avatarUrl(kind, uid) {
  return `/api/v1/avatars/${kind}/${encodeURIComponent(uid)}`;
}

export function avatarRoutes(pool, authenticate) {
  const api = express.Router();
  const auth = authenticate(true);

  // --- user avatar ----------------------------------------------------------

  api.post('/user/avatar', auth, async (req, res) => {
    const decoded = decodeAvatar(req.body?.data, req.body?.mime);
    if (!decoded) {
      res.status(400).json({ message: 'Invalid image (must be PNG, JPEG, WebP, or GIF, max 2MB)' });
      return;
    }
    await pool.query('UPDATE users SET avatar_data = $1, avatar_mime = $2 WHERE uid = $3', [
      decoded.buf,
      decoded.mime,
      req.auth.user.uid,
    ]);
    res.json({ ok: true, avatar_url: avatarUrl('user', req.auth.user.uid) });
  });

  api.delete('/user/avatar', auth, async (req, res) => {
    await pool.query('UPDATE users SET avatar_data = NULL, avatar_mime = NULL WHERE uid = $1', [
      req.auth.user.uid,
    ]);
    res.json({ ok: true });
  });

  // --- space / org avatar ---------------------------------------------------

  async function canEditSpace(uid, user) {
    if (user.admin) return true;
    const { rows } = await pool.query(
      'SELECT 1 FROM space_members WHERE space_uid = $1 AND user_uid = $2',
      [uid, user.uid],
    );
    return rows.length > 0;
  }

  api.post('/spaces/:uid/avatar', auth, async (req, res) => {
    const uid = String(req.params.uid);
    const exists = await pool.query('SELECT uid FROM spaces WHERE uid = $1', [uid]);
    if (exists.rows.length === 0) {
      res.status(404).json({ message: 'Space not found' });
      return;
    }
    if (!(await canEditSpace(uid, req.auth.user))) {
      res.status(403).json({ message: 'No write access to this space' });
      return;
    }
    const decoded = decodeAvatar(req.body?.data, req.body?.mime);
    if (!decoded) {
      res.status(400).json({ message: 'Invalid image (must be PNG, JPEG, WebP, or GIF, max 2MB)' });
      return;
    }
    await pool.query('UPDATE spaces SET avatar_data = $1, avatar_mime = $2 WHERE uid = $3', [
      decoded.buf,
      decoded.mime,
      uid,
    ]);
    res.json({ ok: true, avatar_url: avatarUrl('space', uid) });
  });

  api.delete('/spaces/:uid/avatar', auth, async (req, res) => {
    const uid = String(req.params.uid);
    if (!(await canEditSpace(uid, req.auth.user))) {
      res.status(403).json({ message: 'No write access to this space' });
      return;
    }
    await pool.query('UPDATE spaces SET avatar_data = NULL, avatar_mime = NULL WHERE uid = $1', [uid]);
    res.json({ ok: true });
  });

  // --- public serving ---------------------------------------------------------

  api.get('/avatars/:kind/:uid', async (req, res) => {
    const { kind, uid } = req.params;
    if (kind !== 'user' && kind !== 'space') {
      res.status(400).json({ message: 'Bad avatar kind' });
      return;
    }
    const table = kind === 'user' ? 'users' : 'spaces';
    const { rows } = await pool.query(`SELECT avatar_data, avatar_mime FROM ${table} WHERE uid = $1`, [uid]);
    if (!rows[0]?.avatar_data) {
      res.status(404).end();
      return;
    }
    res.set('Content-Type', rows[0].avatar_mime || 'image/png');
    // Revalidate so a recently-uploaded/removed avatar reflects immediately.
    res.set('Cache-Control', 'no-cache');
    res.send(rows[0].avatar_data);
  });

  return api;
}
