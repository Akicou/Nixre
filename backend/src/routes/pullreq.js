// Pull request routes — phase 3, the last Gitness API dependency.
// Wire shapes match the UI (PullRequest interface, base64 patches).

import express from 'express';
import { diffRefs, mergeBranches, branchExists } from '../git/repo.js';

function now() {
  return Date.now();
}

async function rowToPr(pool, row) {
  let author = { uid: row.author_uid, display_name: row.author_uid, email: '' };
  let mergedBy;
  const uids = [row.author_uid, row.merged_by_uid].filter(Boolean);
  if (uids.length > 0) {
    const { rows } = await pool.query(
      'SELECT uid, display_name, email FROM users WHERE uid = ANY($1)',
      [uids],
    );
    const byUid = Object.fromEntries(rows.map(u => [u.uid, u]));
    const a = byUid[row.author_uid];
    if (a) author = { uid: a.uid, display_name: a.display_name, email: a.email };
    const m = byUid[row.merged_by_uid];
    if (m) mergedBy = { uid: m.uid, display_name: m.display_name };
  }
  return {
    number: Number(row.number),
    title: row.title,
    description: row.description || '',
    state: row.state,
    is_draft: Boolean(row.is_draft),
    source_branch: row.source_branch,
    target_branch: row.target_branch,
    author,
    created: Number(row.created),
    updated: Number(row.updated),
    merged: row.merged == null ? undefined : Number(row.merged),
    merged_by: mergedBy,
  };
}

export function pullRequestRoutes(pool, authenticate) {
  const api = express.Router();
  const auth = authenticate(true);

  // Resolve `space/repo` + load the repo row; caller checks membership.
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

  // GET /repos/{space}/{repo}/+/pullreq?state=
  api.get('/repos/:space/:repo/\\+/pullreq', auth, async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    const state = ['open', 'merged', 'closed'].includes(String(req.query.state))
      ? String(req.query.state)
      : 'open';
    const { rows } = await pool.query(
      'SELECT * FROM pull_requests WHERE repo_id = $1 AND state = $2 ORDER BY created DESC',
      [repo.id, state],
    );
    const prs = await Promise.all(rows.map(r => rowToPr(pool, r)));
    res.json(prs);
  });

  // POST /repos/{space}/{repo}/+/pullreq
  api.post('/repos/:space/:repo/\\+/pullreq', auth, async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    if (!(await canWrite(pool, repo.space_uid, req.auth.user))) {
      res.status(403).json({ message: 'No write access' });
      return;
    }
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '');
    const sourceBranch = String(req.body?.source_branch || '');
    const targetBranch = String(req.body?.target_branch || repo.default_branch);
    if (!title || !sourceBranch) {
      res.status(400).json({ message: 'title and source_branch are required' });
      return;
    }
    if (sourceBranch === targetBranch) {
      res.status(400).json({ message: 'Source and target branches must differ' });
      return;
    }
    if (!(await branchExists(repo.space_uid, repo.uid, sourceBranch))) {
      res.status(400).json({ message: `Source branch '${sourceBranch}' not found` });
      return;
    }
    if (!(await branchExists(repo.space_uid, repo.uid, targetBranch))) {
      res.status(400).json({ message: `Target branch '${targetBranch}' not found` });
      return;
    }

    const dup = await pool.query(
      `SELECT id FROM pull_requests WHERE repo_id = $1 AND source_branch = $2
       AND target_branch = $3 AND state = 'open'`,
      [repo.id, sourceBranch, targetBranch],
    );
    if (dup.rows.length > 0) {
      res.status(409).json({ message: 'An open pull request already exists for these branches' });
      return;
    }

    const ts = now();
    const next = await pool.query(
      'SELECT coalesce(max(number), 0) + 1 AS n FROM pull_requests WHERE repo_id = $1',
      [repo.id],
    );
    const number = next.rows[0].n;
    const { rows } = await pool.query(
      `INSERT INTO pull_requests (repo_id, number, title, description, source_branch, target_branch, state, author_uid, created, updated)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $8) RETURNING *`,
      [repo.id, number, title, description, sourceBranch, targetBranch, req.auth.user.uid, ts],
    );
    await pool.query('UPDATE repos SET updated = $2 WHERE id = $1', [repo.id, ts]);
    res.status(201).json(await rowToPr(pool, rows[0]));
  });

  // GET /repos/{space}/{repo}/+/pullreq/{n}
  api.get('/repos/:space/:repo/\\+/pullreq/:number', auth, async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    const { rows } = await pool.query(
      'SELECT * FROM pull_requests WHERE repo_id = $1 AND number = $2',
      [repo.id, Number(req.params.number)],
    );
    if (rows.length === 0) {
      res.status(404).json({ message: 'Pull request not found' });
      return;
    }
    res.json(await rowToPr(pool, rows[0]));
  });

  // GET /repos/{space}/{repo}/+/pullreq/{n}/diff?include_patch=true
  api.get('/repos/:space/:repo/\\+/pullreq/:number/diff', auth, async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    const { rows } = await pool.query(
      'SELECT * FROM pull_requests WHERE repo_id = $1 AND number = $2',
      [repo.id, Number(req.params.number)],
    );
    const pr = rows[0];
    if (!pr) {
      res.status(404).json({ message: 'Pull request not found' });
      return;
    }
    try {
      const files = await diffRefs(repo.space_uid, repo.uid, pr.target_branch, pr.source_branch);
      res.json(
        files.map(f => ({
          ...f,
          // The UI decodes base64 patches (ui/src/lib/diff.ts).
          patch: Buffer.from(f.patch, 'utf8').toString('base64'),
        })),
      );
    } catch (err) {
      console.error('diff failed:', err.message);
      res.json([]);
    }
  });

  // POST /repos/{space}/{repo}/+/pullreq/{n}/merge {method}
  api.post('/repos/:space/:repo/\\+/pullreq/:number/merge', auth, async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    if (!(await canWrite(pool, repo.space_uid, req.auth.user))) {
      res.status(403).json({ message: 'No write access' });
      return;
    }
    const { rows } = await pool.query(
      'SELECT * FROM pull_requests WHERE repo_id = $1 AND number = $2',
      [repo.id, Number(req.params.number)],
    );
    const pr = rows[0];
    if (!pr) {
      res.status(404).json({ message: 'Pull request not found' });
      return;
    }
    if (pr.state !== 'open') {
      res.status(409).json({ message: `Pull request is already ${pr.state}` });
      return;
    }
    const method = ['merge', 'squash'].includes(String(req.body?.method))
      ? String(req.body?.method)
      : 'merge';

    try {
      await mergeBranches(repo.space_uid, repo.uid, pr.target_branch, pr.source_branch, method, {
        authorName: req.auth.user.display_name || req.auth.user.uid,
        authorEmail: req.auth.user.email,
      });
    } catch (err) {
      console.error('merge failed:', err.message);
      res.status(422).json({ message: 'Merge failed (conflicts?) — branches diverged irreconcilably.' });
      return;
    }

    const ts = now();
    const { rows: updated } = await pool.query(
      `UPDATE pull_requests SET state = 'merged', merged = $2, merged_by_uid = $3, updated = $2
       WHERE id = $1 RETURNING *`,
      [pr.id, ts, req.auth.user.uid],
    );
    await pool.query('UPDATE repos SET updated = $2 WHERE id = $1', [repo.id, ts]);
    res.json(await rowToPr(pool, updated[0]));
  });

  // POST /repos/{space}/{repo}/+/pullreq/{n}/state {state: closed|open}
  api.post('/repos/:space/:repo/\\+/pullreq/:number/state', auth, async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    if (!(await canWrite(pool, repo.space_uid, req.auth.user))) {
      res.status(403).json({ message: 'No write access' });
      return;
    }
    const state = String(req.body?.state);
    if (!['open', 'closed'].includes(state)) {
      res.status(400).json({ message: 'state must be open or closed' });
      return;
    }
    const { rows } = await pool.query(
      'UPDATE pull_requests SET state = $3, updated = $4 WHERE repo_id = $1 AND number = $2 AND state <> $3 RETURNING *',
      [repo.id, Number(req.params.number), state, now()],
    );
    if (rows.length === 0) {
      res.status(404).json({ message: 'Pull request not found or already in that state' });
      return;
    }
    res.json(await rowToPr(pool, rows[0]));
  });

  return api;
}

// Open-PR count for repo listings (wired into forge.js rowToRepo).
export async function openPrCounts(pool, repoIds) {
  if (repoIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT repo_id, count(*)::int AS n FROM pull_requests
     WHERE repo_id = ANY($1) AND state = 'open' GROUP BY repo_id`,
    [repoIds],
  );
  return new Map(rows.map(r => [Number(r.repo_id), r.n]));
}
