// Spaces + repos routes — phase 2 of the sovereignty plan.
// Metadata in Postgres, git objects on disk (src/git/repo.js). Response
// shapes match what the UI's api.ts expects (Gitness-compatible).

import express from 'express';
import {
  initBareRepo,
  removeBareRepo,
  listTree,
  readBlob,
  listCommits,
  listBranches,
  resolveDefaultBranch,
  validRefSegment,
} from '../git/repo.js';

function now() {
  return Date.now();
}

function rowToSpace(row) {
  return {
    id: row.numeric_id ?? 0,
    uid: row.uid,
    path: row.uid,
    identifier: row.uid,
    description: row.description || '',
    is_public: Boolean(row.is_public),
    created: Number(row.created),
    created_by: row.created_by,
    updated: Number(row.updated),
  };
}

function rowToRepo(row, { openPulls = 0 } = {}) {
  const path = `${row.space_uid}/${row.uid}`;
  return {
    id: Number(row.id),
    uid: row.uid,
    path,
    identifier: row.uid,
    description: row.description || '',
    is_public: Boolean(row.is_public),
    default_branch: row.default_branch,
    git_url: path,
    git_ssh_url: path,
    size: 0,
    num_forks: 0,
    num_pulls: openPulls,
    num_open_pulls: openPulls,
    num_closed_pulls: 0,
    num_merged_pulls: 0,
    created: Number(row.created),
    updated: Number(row.updated),
  };
}

// membership: owner, member of the space, or instance admin
async function canAccessSpace(pool, spaceUid, user) {
  if (user.admin) return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM space_members WHERE space_uid = $1 AND user_uid = $2',
    [spaceUid, user.uid],
  );
  return rows.length > 0;
}

async function canWriteRepo(pool, spaceUid, user) {
  return canAccessSpace(pool, spaceUid, user);
}

// Look up a repo row from `space/repo`; throws 404-shaped null if absent.
async function findRepo(pool, repoRef) {
  const [space, ...rest] = String(repoRef).split('/');
  const uid = rest.join('/').replace(/\.git$/, '');
  if (!validRefSegment(space) || !validRefSegment(uid)) return null;
  const { rows } = await pool.query(
    'SELECT * FROM repos WHERE space_uid = $1 AND uid = $2',
    [space, uid],
  );
  return rows[0] ?? null;
}

export function forgeRoutes(pool, authenticate) {
  const api = express.Router();
  const auth = authenticate(true);

  // --- spaces ----------------------------------------------------------------

  // Shape-compatible with the UI's listSpaces() membership mapping.
  api.get('/user/memberships', auth, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT s.*, sm.role FROM spaces s
       JOIN space_members sm ON sm.space_uid = s.uid
       WHERE sm.user_uid = $1
       ORDER BY s.uid`,
      [req.auth.user.uid],
    );
    res.json(rows.map(r => ({ space: rowToSpace(r), role: r.role })));
  });

  api.get('/spaces', auth, async (req, res) => {
    const visibility = req.auth.user.admin
      ? ''
      : `WHERE s.is_public OR EXISTS (
           SELECT 1 FROM space_members m WHERE m.space_uid = s.uid AND m.user_uid = $1)`;
    const params = req.auth.user.admin ? [] : [req.auth.user.uid];
    const { rows } = await pool.query(`SELECT s.* FROM spaces s ${visibility} ORDER BY s.uid`, params);
    res.json(rows.map(rowToSpace));
  });

  api.get('/spaces/:spaceUid', auth, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM spaces WHERE uid = $1', [req.params.spaceUid]);
    if (rows.length === 0) {
      res.status(404).json({ message: 'Space not found' });
      return;
    }
    const space = rows[0];
    if (!space.is_public && !(await canAccessSpace(pool, space.uid, req.auth.user))) {
      res.status(403).json({ message: 'No access to this space' });
      return;
    }
    res.json(rowToSpace(space));
  });

  api.post('/spaces', auth, async (req, res) => {
    const uid = String(req.body?.uid || '').trim();
    const description = String(req.body?.description || '');
    const isPublic = Boolean(req.body?.is_public);
    if (!validRefSegment(uid)) {
      res.status(400).json({ message: 'Invalid space uid' });
      return;
    }
    const exists = await pool.query('SELECT uid FROM spaces WHERE uid = $1', [uid]);
    if (exists.rows.length > 0) {
      res.status(409).json({ message: 'Space already exists' });
      return;
    }
    const ts = now();
    const { rows } = await pool.query(
      `INSERT INTO spaces (uid, description, is_public, created_by, created, updated)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
      [uid, description, isPublic, req.auth.user.uid, ts],
    );
    await pool.query(
      'INSERT INTO space_members (space_uid, user_uid, role, created) VALUES ($1, $2, $3, $4)',
      [uid, req.auth.user.uid, 'owner', ts],
    );
    res.status(201).json(rowToSpace(rows[0]));
  });

  // --- repos -------------------------------------------------------------------

  api.get('/spaces/:spaceUid/repos', auth, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM repos WHERE space_uid = $1 ORDER BY uid',
      [req.params.spaceUid],
    );
    res.json(rows.map(r => rowToRepo(r)));
  });

  api.post('/repos', auth, async (req, res) => {
    const spaceUid = String(req.body?.parent_ref || '');
    const uid = String(req.body?.uid || '').trim();
    const description = String(req.body?.description || '');
    const isPublic = req.body?.is_public !== false;
    const readme = req.body?.readme !== false;
    const defaultBranch = String(req.body?.default_branch || 'main');

    if (!validRefSegment(spaceUid) || !validRefSegment(uid)) {
      res.status(400).json({ message: 'Invalid repo ref' });
      return;
    }
    const space = await pool.query('SELECT * FROM spaces WHERE uid = $1', [spaceUid]);
    if (space.rows.length === 0) {
      res.status(404).json({ message: 'Space not found' });
      return;
    }
    if (!(await canWriteRepo(pool, spaceUid, req.auth.user))) {
      res.status(403).json({ message: 'No write access to this space' });
      return;
    }
    const exists = await pool.query(
      'SELECT id FROM repos WHERE space_uid = $1 AND uid = $2',
      [spaceUid, uid],
    );
    if (exists.rows.length > 0) {
      res.status(409).json({ message: 'Repo already exists' });
      return;
    }

    const ts = now();
    const { rows } = await pool.query(
      `INSERT INTO repos (space_uid, uid, description, is_public, default_branch, created_by, created, updated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
      [spaceUid, uid, description, isPublic, defaultBranch, req.auth.user.uid, ts],
    );
    const repo = rows[0];

    await initBareRepo(spaceUid, uid, { defaultBranch });
    if (readme) {
      const { seedReadme } = await import('../git/repo.js');
      await seedReadme(spaceUid, uid, {
        authorName: req.auth.user.display_name || req.auth.user.uid,
        authorEmail: req.auth.user.email,
        description,
      }).catch(err => console.error('seedReadme failed:', err.message));
    }
    res.status(201).json(rowToRepo(repo));
  });

  // /repos/{space}/{repo}/+ — the UI's canonical repo resource path.
  api.get('/repos/:space/:repo/\\+', auth, async (req, res) => {
    const repo = await findRepo(pool, `${req.params.space}/${req.params.repo}`);
    if (!repo) {
      res.status(404).json({ message: 'Repository not found' });
      return;
    }
    res.json(rowToRepo(repo));
  });

  api.patch('/repos/:space/:repo/\\+', auth, async (req, res) => {
    const repo = await findRepo(pool, `${req.params.space}/${req.params.repo}`);
    if (!repo) {
      res.status(404).json({ message: 'Repository not found' });
      return;
    }
    if (!(await canWriteRepo(pool, repo.space_uid, req.auth.user))) {
      res.status(403).json({ message: 'No write access' });
      return;
    }
    const description = req.body?.description !== undefined ? String(req.body.description) : repo.description;
    const isPublic = req.body?.is_public !== undefined ? Boolean(req.body.is_public) : repo.is_public;
    const { rows } = await pool.query(
      'UPDATE repos SET description = $1, is_public = $2, updated = $3 WHERE id = $4 RETURNING *',
      [description, isPublic, now(), repo.id],
    );
    res.json(rowToRepo(rows[0]));
  });

  api.delete('/repos/:space/:repo/\\+', auth, async (req, res) => {
    const repo = await findRepo(pool, `${req.params.space}/${req.params.repo}`);
    if (!repo) {
      res.status(404).json({ message: 'Repository not found' });
      return;
    }
    if (!(await canWriteRepo(pool, repo.space_uid, req.auth.user))) {
      res.status(403).json({ message: 'No write access' });
      return;
    }
    await pool.query('DELETE FROM repos WHERE id = $1', [repo.id]);
    await removeBareRepo(repo.space_uid, repo.uid).catch(() => {});
    res.json({ ok: true });
  });

  // --- git data ------------------------------------------------------------------

  // Content listing: GET /repos/{space}/{repo}/+/content/{path}?git_ref=
  // (both forms registered: bare /content for the root listing, /* for paths)
  const contentHandler = async (req, res) => {
    const repo = await findRepo(pool, `${req.params.space}/${req.params.repo}`);
    if (!repo) {
      res.status(404).json({ message: 'Repository not found' });
      return;
    }
    const ref = String(req.query.git_ref || repo.default_branch);
    const dirPath = String(req.params[0] || '');
    try {
      const entries = await listTree(repo.space_uid, repo.uid, ref, dirPath);
      res.json({
        content: {
          entries: entries.map(e => ({
            type: e.type,
            name: e.name,
            path: dirPath ? `${dirPath}/${e.name}` : e.name,
            mode: e.type === 'dir' ? 0 : 100644,
            sha: e.sha,
            size: e.size,
          })),
        },
      });
    } catch {
      res.status(404).json({ message: 'Path or ref not found' });
    }
  };
  api.get('/repos/:space/:repo/\\+/content', auth, contentHandler);
  api.get('/repos/:space/:repo/\\+/content/*', auth, contentHandler);

  // Raw blob: GET /repos/{space}/{repo}/+/raw/{path}?git_ref=
  api.get('/repos/:space/:repo/\\+/raw/*', auth, async (req, res) => {
    const repo = await findRepo(pool, `${req.params.space}/${req.params.repo}`);
    if (!repo) {
      res.status(404).json({ message: 'Repository not found' });
      return;
    }
    const ref = String(req.query.git_ref || repo.default_branch);
    const filePath = String(req.params[0] || '');
    try {
      const { content, size } = await readBlob(repo.space_uid, repo.uid, ref, filePath);
      res.set('Content-Type', 'application/octet-stream');
      res.send(content);
      void size;
    } catch {
      res.status(404).json({ message: 'Path or ref not found' });
    }
  });

  // Commits: GET /repos/{space}/{repo}/+/commits?git_ref=&page=&limit=
  api.get('/repos/:space/:repo/\\+/commits', auth, async (req, res) => {
    const repo = await findRepo(pool, `${req.params.space}/${req.params.repo}`);
    if (!repo) {
      res.status(404).json({ message: 'Repository not found' });
      return;
    }
    const ref = String(req.query.git_ref || repo.default_branch);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 25);
    try {
      const commits = await listCommits(repo.space_uid, repo.uid, ref, { page, limit });
      res.json({ commits });
    } catch {
      res.json({ commits: [] });
    }
  });

  // Branches: GET /repos/{space}/{repo}/+/branches
  api.get('/repos/:space/:repo/\\+/branches', auth, async (req, res) => {
    const repo = await findRepo(pool, `${req.params.space}/${req.params.repo}`);
    if (!repo) {
      res.status(404).json({ message: 'Repository not found' });
      return;
    }
    try {
      const defaultBranch = await resolveDefaultBranch(repo.space_uid, repo.uid, repo.default_branch);
      const branches = await listBranches(repo.space_uid, repo.uid, defaultBranch);
      res.json({
        branches: branches.map(b => ({
          name: b.name,
          sha: b.sha,
          commit: {
            sha: b.sha,
            title: b.subject,
            message: b.subject,
            author: { identity: { name: b.authorName, email: '' }, when: b.date },
            committer: { identity: { name: b.authorName, email: '' }, when: b.date },
          },
        })),
      });
    } catch {
      res.json({ branches: [] });
    }
  });

  return api;
}

export { findRepo };
