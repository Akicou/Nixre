// Spaces + repos routes — phase 2 of the sovereignty plan.
// Metadata in Postgres, git objects on disk (src/git/repo.js). Response
// shapes match what the UI's api.ts expects (Gitness-compatible).

import express from 'express';
import {
  initBareRepo,
  hasHead,
  removeBareRepo,
  listTree,
  readBlob,
  listCommits,
  getCommit,
  listBranches,
  resolveDefaultBranch,
  validRefSegment,
} from '../git/repo.js';
import { openPrCounts } from './pullreq.js';

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
    is_personal: Boolean(row.is_personal),
    avatar_url: row.avatar_data ? `/api/v1/avatars/space/${row.uid}` : '',
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

// Initials-style avatar (matches the space/user initials used across the UI).
function avatarFor(name) {
  return String(name || '').slice(0, 2).toUpperCase();
}

// Enrich git commit author/committer identities with the matching Nixre user
// (by email) so the UI can render an avatar + profile link. Best-effort: a
// commit authored with a foreign email just keeps its git identity (linked:false).
async function enrichCommits(pool, commits) {
  if (!commits.length) return commits;
  const emails = new Set();
  for (const c of commits) {
    if (c.author?.identity?.email) emails.add(c.author.identity.email.toLowerCase());
    if (c.committer?.identity?.email) emails.add(c.committer.identity.email.toLowerCase());
  }
  const { rows } = await pool.query(
    'SELECT uid, email, display_name, avatar_data FROM users WHERE lower(email) = ANY($1)',
    [[...emails]],
  );
  const byEmail = new Map(rows.map(r => [r.email.toLowerCase(), r]));
  for (const c of commits) {
    for (const key of ['author', 'committer']) {
      const ident = c[key]?.identity;
      if (!ident?.email) continue;
      const user = byEmail.get(ident.email.toLowerCase());
      c[key].uid = user?.uid || null;
      c[key].display_name = user?.display_name || ident.name;
      c[key].avatar = avatarFor(user?.uid || ident.name);
      c[key].avatar_url = user?.avatar_data ? `/api/v1/avatars/user/${user.uid}` : '';
      c[key].linked = Boolean(user);
    }
  }
  return commits;
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
    res.json({ ...rowToSpace(space), is_member: await canAccessSpace(pool, space.uid, req.auth.user) });
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
    // Members & admins see all repos; anyone else on a public space only
    // sees public ones (a private repo must not leak on a public profile).
    const member = await canAccessSpace(pool, req.params.spaceUid, req.auth.user);
    const { rows } = await pool.query(
      `SELECT * FROM repos WHERE space_uid = $1 ${member ? '' : 'AND is_public = TRUE'} ORDER BY uid`,
      [req.params.spaceUid],
    );
    const counts = await openPrCounts(pool, rows.map(r => Number(r.id)));
    res.json(rows.map(r => rowToRepo(r, { openPulls: counts.get(Number(r.id)) ?? 0 })));
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
    const existing = await pool.query(
      'SELECT * FROM repos WHERE space_uid = $1 AND uid = $2',
      [spaceUid, uid],
    );
    let repo = existing.rows[0] ?? null;
    let created = false;
    if (!repo) {
      const ts = now();
      try {
        const { rows } = await pool.query(
          `INSERT INTO repos (space_uid, uid, description, is_public, default_branch, created_by, created, updated)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
          [spaceUid, uid, description, isPublic, defaultBranch, req.auth.user.uid, ts],
        );
        repo = rows[0];
        created = true;
      } catch (err) {
        // Concurrent create: unique (space_uid, uid). Treat as already there.
        if (err.code !== '23505') throw err;
        const again = await pool.query(
          'SELECT * FROM repos WHERE space_uid = $1 AND uid = $2',
          [spaceUid, uid],
        );
        repo = again.rows[0];
      }
    }

    try {
      await initBareRepo(spaceUid, uid, { defaultBranch });
      // Seed when this is a new row or a retry left an empty bare repo
      // (the usual 502 → "already exists" path). Skip if HEAD already exists.
      if (readme && (created || !(await hasHead(spaceUid, uid)))) {
        const { seedReadme } = await import('../git/repo.js');
        await seedReadme(spaceUid, uid, {
          authorName: req.auth.user.display_name || req.auth.user.uid,
          authorEmail: req.auth.user.email,
          description,
        }).catch(err => console.error('seedReadme failed:', err.message));
      }
    } catch (err) {
      console.error('initBareRepo failed:', err.message);
      res.status(502).json({ message: err.message || 'Failed to initialize git repository' });
      return;
    }
    res.status(created ? 201 : 200).json(rowToRepo(repo));
  });

  // /repos/{space}/{repo}/+ — the UI's canonical repo resource path.
  api.get('/repos/:space/:repo/\\+', auth, async (req, res) => {
    const repo = await findRepo(pool, `${req.params.space}/${req.params.repo}`);
    if (!repo) {
      res.status(404).json({ message: 'Repository not found' });
      return;
    }
    const counts = await openPrCounts(pool, [Number(repo.id)]);
    res.json(rowToRepo(repo, { openPulls: counts.get(Number(repo.id)) ?? 0 }));
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

  // Commits: GET /repos/{space}/{repo}/+/commits?git_ref=&path=&page=&limit=
  api.get('/repos/:space/:repo/\\+/commits', auth, async (req, res) => {
    const repo = await findRepo(pool, `${req.params.space}/${req.params.repo}`);
    if (!repo) {
      res.status(404).json({ message: 'Repository not found' });
      return;
    }
    const ref = String(req.query.git_ref || repo.default_branch);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 25);
    const path = req.query.path ? String(req.query.path) : undefined;
    const follow = req.query.follow === 'true' || req.query.follow === '1';
    try {
      const commits = await listCommits(repo.space_uid, repo.uid, ref, { page, limit, path, follow });
      res.json({ commits: await enrichCommits(pool, commits) });
    } catch {
      res.json({ commits: [] });
    }
  });

  // Commit detail: GET /repos/{space}/{repo}/+/commits/{sha}
  api.get('/repos/:space/:repo/\\+/commits/:sha', auth, async (req, res) => {
    const repo = await findRepo(pool, `${req.params.space}/${req.params.repo}`);
    if (!repo) {
      res.status(404).json({ message: 'Repository not found' });
      return;
    }
    try {
      const { commit, stats, files } = await getCommit(repo.space_uid, repo.uid, req.params.sha);
      const [enriched] = await enrichCommits(pool, [commit]);
      res.json({ commit: enriched, stats, files });
    } catch {
      res.status(404).json({ message: 'Commit not found' });
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

  // User profile: GET /users/{uid} — the GitHub-style profile. Reads the
  // user's personal namespace and lists its (public) repositories.
  api.get('/users/:uid', auth, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM users WHERE uid = $1', [req.params.uid]);
    if (rows.length === 0) {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    const u = rows[0];
    const isSelf = req.auth.user.uid === u.uid;
    const canSeeAll = req.auth.user.admin || isSelf;
    const spaceRes = await pool.query('SELECT * FROM spaces WHERE uid = $1 AND is_personal = TRUE', [u.uid]);
    const personal = spaceRes.rows[0] || null;
    const reposRes = await pool.query(
      `SELECT * FROM repos WHERE space_uid = $1 ${canSeeAll ? '' : 'AND is_public = TRUE'} ORDER BY uid`,
      [u.uid],
    );
    const counts = await openPrCounts(pool, reposRes.rows.map(r => Number(r.id)));
    res.json({
      uid: u.uid,
      display_name: u.display_name,
      email: canSeeAll ? u.email : '',
      is_self: isSelf,
      is_member: canSeeAll,
      is_admin: Boolean(u.admin),
      bio: personal?.description || '',
      is_public: personal?.is_public ?? false,
      avatar: avatarFor(u.uid),
      avatar_url: u.avatar_data ? `/api/v1/avatars/user/${u.uid}` : '',
      created: Number(u.created),
      repos: reposRes.rows.map(r => rowToRepo(r, { openPulls: counts.get(Number(r.id)) ?? 0 })),
    });
  });

  return api;
}

export { findRepo };
