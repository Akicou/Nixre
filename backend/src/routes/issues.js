// Repository issues. Visibility follows the repo (guests read public repos);
// writing needs space membership, like pull requests.

import express from 'express';
import { loadReadableRepo, canWriteRepo } from '../lib/repoAccess.js';
import {
  addComment, cleanLabels, commentsPublic, createIssue, issuesPublic, setIssueState, validateIssueInput,
} from '../lib/issues.js';

const R = '/repos/:space/:repo/\\+/issues';

export function issueRoutes(pool, authenticate) {
  const api = express.Router();
  const auth = authenticate(true);
  const optionalAuth = authenticate(false);

  async function loadRepo(req, res) {
    const { repo, error } = await loadReadableRepo(pool, req.params.space, req.params.repo, req.auth?.user ?? null);
    if (error) {
      res.status(error.status).json({ message: error.message });
      return null;
    }
    return repo;
  }

  async function loadWritable(req, res) {
    const repo = await loadRepo(req, res);
    if (!repo) return null;
    if (!(await canWriteRepo(pool, repo, req.auth.user))) {
      res.status(403).json({ message: 'No write access' });
      return null;
    }
    return repo;
  }

  async function loadIssue(req, res, repo) {
    const number = Number(req.params.number);
    const { rows } = Number.isSafeInteger(number)
      ? await pool.query('SELECT * FROM issues WHERE repo_id = $1 AND number = $2', [repo.id, number])
      : { rows: [] };
    if (!rows[0]) {
      res.status(404).json({ message: 'Issue not found' });
      return null;
    }
    return rows[0];
  }

  api.get(R, optionalAuth, async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    const state = ['open', 'closed', 'all'].includes(String(req.query.state)) ? String(req.query.state) : 'open';
    const { rows } = await pool.query(
      `SELECT * FROM issues WHERE repo_id = $1 AND ($2 = 'all' OR state = $2) ORDER BY created DESC LIMIT 500`,
      [repo.id, state],
    );
    res.json(await issuesPublic(pool, rows));
  });

  api.post(R, auth, async (req, res) => {
    const repo = await loadWritable(req, res);
    if (!repo) return;
    const v = validateIssueInput(req.body ?? {});
    if (v.error) return res.status(400).json({ message: v.error });
    const row = await createIssue(pool, {
      repoId: repo.id, title: v.title, body: v.body, labels: req.body?.labels, authorUid: req.auth.user.uid,
    });
    res.status(201).json((await issuesPublic(pool, [row]))[0]);
  });

  api.get(`${R}/:number`, optionalAuth, async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    const row = await loadIssue(req, res, repo);
    if (!row) return;
    const { rows: comments } = await pool.query(
      'SELECT * FROM issue_comments WHERE issue_id = $1 ORDER BY id', [row.id],
    );
    res.json({ issue: (await issuesPublic(pool, [row]))[0], comments: await commentsPublic(pool, comments) });
  });

  api.patch(`${R}/:number`, auth, async (req, res) => {
    const repo = await loadWritable(req, res);
    if (!repo) return;
    const row = await loadIssue(req, res, repo);
    if (!row) return;
    const b = req.body ?? {};
    const v = validateIssueInput({ title: b.title ?? row.title, body: b.body ?? row.body });
    if (v.error) return res.status(400).json({ message: v.error });
    if (b.state !== undefined && !['open', 'closed'].includes(b.state)) {
      return res.status(400).json({ message: "state must be 'open' or 'closed'" });
    }
    await pool.query(
      'UPDATE issues SET title = $2, body = $3, labels = $4::jsonb, updated = $5 WHERE id = $1',
      [row.id, v.title, v.body, JSON.stringify(b.labels === undefined ? row.labels : cleanLabels(b.labels)), Date.now()],
    );
    const updated = b.state && b.state !== row.state
      ? await setIssueState(pool, row.id, b.state)
      : (await pool.query('SELECT * FROM issues WHERE id = $1', [row.id])).rows[0];
    res.json((await issuesPublic(pool, [updated]))[0]);
  });

  api.post(`${R}/:number/comments`, auth, async (req, res) => {
    const repo = await loadWritable(req, res);
    if (!repo) return;
    const row = await loadIssue(req, res, repo);
    if (!row) return;
    const body = String(req.body?.body ?? '').trim();
    if (!body || body.length > 60_000) return res.status(400).json({ message: 'comment body is required (max 60000 chars)' });
    const c = await addComment(pool, { issueId: row.id, authorUid: req.auth.user.uid, body });
    res.status(201).json((await commentsPublic(pool, [c]))[0]);
  });

  return api;
}
