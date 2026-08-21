// Internal routes — consumed by sibling containers (nixre-ssh), not the UI.
// Authenticated with the shared INTERNAL_TOKEN secret.

import express from 'express';
import crypto from 'node:crypto';

export function internalRoutes(pool, authenticate) {
  const api = express.Router();

  // Shared-secret guard. Set INTERNAL_TOKEN in compose; the ssh container
  // calls with it.
  const internalToken = process.env.INTERNAL_TOKEN || '';
  const internalAuth = (req, res, next) => {
    if (!internalToken) {
      res.status(503).json({ message: 'INTERNAL_TOKEN not configured' });
      return;
    }
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${internalToken}`) {
      res.status(401).json({ message: 'Bad internal token' });
      return;
    }
    next();
  };

  // GET /internal/keys/all -> authorized_keys lines for every user, each
  // wrapped with a per-key ForcedCommand pinned to the owner's uid (the
  // standard Gitea-style SSH passthrough pattern). Consumed by sshd's
  // AuthorizedKeysCommand in the nixre-ssh container.
  api.get('/internal/keys/all', internalAuth, async (_req, res) => {
    const { rows } = await pool.query(
      'SELECT user_uid, content FROM public_keys ORDER BY user_uid, created',
    );
    const lines = rows.map(r => {
      const owner = r.user_uid.replace(/[^a-z0-9-_.]/gi, '');
      const key = r.content.trim();
      const opts = 'no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty';
      return `command="/srv/nixre-git-shell ${owner}",${opts} ${key}`;
    });
    res.type('text/plain').send(lines.map(l => `${l}\n`).join(''));
  });

  // GET /internal/access/{uid}/{space}/{repo} -> { exists, read, write }
  // The git-shell ForcedCommand wrapper asks core whether the user may act.
  api.get('/internal/access/:uid/:space/:repo', internalAuth, async (req, res) => {
    const { uid, space, repo } = req.params;
    const { rows } = await pool.query(
      'SELECT is_public FROM repos WHERE space_uid = $1 AND uid = $2',
      [space, repo],
    );
    if (rows.length === 0) {
      res.json({ exists: false, read: false, write: false });
      return;
    }
    const member = await pool.query(
      `SELECT 1 FROM space_members WHERE space_uid = $1 AND user_uid = $2
       UNION SELECT 1 FROM users WHERE uid = $2 AND admin = TRUE`,
      [space, uid],
    );
    const isMember = member.rows.length > 0;
    res.json({ exists: true, read: rows[0].is_public || isMember, write: isMember });
  });

  // POST /internal/push-event — called by the SSH-side post-receive hook
  // and by smartHttp's own post-receive handling; fans out repo webhooks.
  api.post('/internal/push-event', internalAuth, async (req, res) => {
    const { space, repo, branch, before, after, pusher } = req.body || {};
    if (!space || !repo || !branch) {
      res.status(400).json({ message: 'space, repo, branch required' });
      return;
    }
    try {
      const { fireWebhooks } = await import('../lib/webhooks.js');
      const deliveries = await fireWebhooks(pool, space, repo, {
        type: 'push',
        branch,
        before: String(before || ''),
        after: String(after || ''),
        pusher: String(pusher || ''),
      });
      res.json({ deliveries });
    } catch (err) {
      console.error('push-event failed:', err.message);
      res.status(500).json({ message: 'webhook fanout failed' });
    }
  });

  void authenticate;
  void crypto;
  return api;
}
