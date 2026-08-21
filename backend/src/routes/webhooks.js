// Webhook routes — repo-scoped webhook management (phase 5).

import express from 'express';
import crypto from 'node:crypto';

export function webhookRoutes(pool, authenticate) {
  const api = express.Router();
  const auth = authenticate(true);

  async function loadRepo(req, res) {
    const { space, repo } = req.params;
    const { rows } = await pool.query(
      'SELECT * FROM repos WHERE space_uid = $1 AND uid = $2',
      [space, repo],
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ message: 'Repository not found' });
      return null;
    }
    return row;
  }

  async function canWrite(pool, spaceUid, user) {
    if (user.admin) return true;
    const { rows } = await pool.query(
      'SELECT 1 FROM space_members WHERE space_uid = $1 AND user_uid = $2',
      [spaceUid, user.uid],
    );
    return rows.length > 0;
  }

  // GET /repos/{space}/{repo}/+/webhooks
  api.get('/repos/:space/:repo/\\+/webhooks', auth, async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    const { rows } = await pool.query(
      'SELECT id, url, events, active, created FROM repo_webhooks WHERE repo_id = $1 ORDER BY created DESC',
      [repo.id],
    );
    res.json(rows.map(r => ({
      identifier: String(r.id),
      url: r.url,
      events: r.events,
      active: r.active,
      created: Number(r.created),
    })));
  });

  // POST /repos/{space}/{repo}/+/webhooks {url, events?}
  // Returns the signing secret exactly once.
  api.post('/repos/:space/:repo/\\+/webhooks', auth, async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    if (!(await canWrite(pool, repo.space_uid, req.auth.user))) {
      res.status(403).json({ message: 'No write access' });
      return;
    }
    const url = String(req.body?.url || '');
    const events = Array.isArray(req.body?.events)
      ? req.body.events.filter(e => ['push', 'pull_request'].includes(e))
      : ['push', 'pull_request'];
    if (!/^https?:\/\//.test(url)) {
      res.status(400).json({ message: 'url must be http(s)' });
      return;
    }
    if (events.length === 0) {
      res.status(400).json({ message: 'at least one event required (push, pull_request)' });
      return;
    }
    const secret = crypto.randomBytes(24).toString('base64url');
    const { rows } = await pool.query(
      `INSERT INTO repo_webhooks (repo_id, url, secret, events, created_by, created)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [repo.id, url, secret, events, req.auth.user.uid, Date.now()],
    );
    res.status(201).json({ identifier: String(rows[0].id), url, events, secret, active: true });
  });

  // DELETE /repos/{space}/{repo}/+/webhooks/{id}
  api.delete('/repos/:space/:repo/\\+/webhooks/:id', auth, async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    if (!(await canWrite(pool, repo.space_uid, req.auth.user))) {
      res.status(403).json({ message: 'No write access' });
      return;
    }
    await pool.query('DELETE FROM repo_webhooks WHERE id = $1 AND repo_id = $2', [
      Number(req.params.id),
      repo.id,
    ]);
    res.json({ ok: true });
  });

  // GET /repos/{space}/{repo}/+/webhooks/{id}/deliveries
  api.get('/repos/:space/:repo/\\+/webhooks/:id/deliveries', auth, async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    const { rows } = await pool.query(
      `SELECT d.id, d.event_type, d.status_code, d.ok, d.attempts, d.created, d.delivered
       FROM webhook_deliveries d
       JOIN repo_webhooks w ON w.id = d.webhook_id
       WHERE w.repo_id = $1 AND w.id = $2
       ORDER BY d.created DESC LIMIT 50`,
      [repo.id, Number(req.params.id)],
    );
    res.json(rows.map(r => ({
      id: Number(r.id),
      event: r.event_type,
      status_code: r.status_code,
      ok: r.ok,
      attempts: r.attempts,
      created: Number(r.created),
      delivered: r.delivered == null ? null : Number(r.delivered),
    })));
  });

  return api;
}
