// Spaces + repos routes — phase 2 of the sovereignty plan.
// Metadata in Postgres, git objects on disk (src/git/repo.js). Response
// shapes match what the UI's api.ts expects (Gitness-compatible).

import express from 'express';
import {
  initBareRepo,
  hasHead,
  removeBareRepo,
  moveBareRepo,
  listTree,
  readBlob,
  listCommits,
  commitDates,
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

const ORG_ROLES = new Set(['owner', 'admin', 'member']);

async function spaceRole(pool, spaceUid, user) {
  const { rows } = await pool.query(
    'SELECT role FROM space_members WHERE space_uid = $1 AND user_uid = $2',
    [spaceUid, user.uid],
  );
  return rows[0]?.role || null;
}

async function viewerFlags(pool, spaceUid, user) {
  const role = await spaceRole(pool, spaceUid, user);
  const instAdmin = Boolean(user.admin);
  return {
    is_member: Boolean(role) || instAdmin,
    role: role || null,
    can_manage: role === 'owner' || role === 'admin' || instAdmin,
    can_transfer: role === 'owner' || instAdmin,
  };
}

// membership: owner, member of the space, or instance admin
async function canAccessSpace(pool, spaceUid, user) {
  if (user.admin) return true;
  return Boolean(await spaceRole(pool, spaceUid, user));
}

async function canWriteRepo(pool, spaceUid, user) {
  return canAccessSpace(pool, spaceUid, user);
}

async function ownerCount(pool, spaceUid) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM space_members WHERE space_uid = $1 AND role = 'owner'`,
    [spaceUid],
  );
  return rows[0]?.n ?? 0;
}

function memberPayload(r) {
  return {
    uid: r.uid,
    display_name: r.display_name,
    role: r.role,
    avatar_url: r.avatar_data ? `/api/v1/avatars/user/${r.uid}` : '',
  };
}

async function listMembers(pool, spaceUid) {
  const { rows } = await pool.query(
    `SELECT u.uid, u.display_name, u.avatar_data, sm.role
     FROM space_members sm
     JOIN users u ON u.uid = sm.user_uid
     WHERE sm.space_uid = $1
     ORDER BY CASE sm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.uid`,
    [spaceUid],
  );
  return rows.map(memberPayload);
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

// Profile README status: a repo named `{uid}/{uid}` that has a README file.
async function profileReadmeStatus(pool, uid) {
  const { rows } = await pool.query('SELECT * FROM repos WHERE space_uid = $1 AND uid = $2', [uid, uid]);
  if (rows.length === 0) return { exists: false, hasReadme: false, repo: null };
  const repo = rows[0];
  let hasReadme = false;
  let readmeName = '';
  try {
    const entries = await listTree(repo.space_uid, repo.uid, repo.default_branch, '');
    const readmeEntry = entries.find(e => e.type === 'file' && /^readme/i.test(e.name));
    if (readmeEntry) {
      hasReadme = true;
      readmeName = readmeEntry.name;
    }
  } catch {
    /* empty repo */
  }
  return {
    exists: true,
    hasReadme,
    repo: {
      space_uid: repo.space_uid,
      uid: repo.uid,
      path: `${repo.space_uid}/${repo.uid}`,
      default_branch: repo.default_branch,
      readme: readmeName || 'README.md',
    },
  };
}

// True when any of the repos has a commit authored by the given email.
async function userCommitted(pool, repoRows, email) {
  if (repoRows.length === 0 || !email) return false;
  const lower = email.toLowerCase();
  for (const r of repoRows) {
    try {
      const commits = await listCommits(r.space_uid, r.uid, r.default_branch, { page: 1, limit: 100 });
      if (commits.some(c => String(c.author?.email || '').toLowerCase() === lower)) return true;
    } catch {
      /* unreadable/branch missing */
    }
  }
  return false;
}

const CONTRIB_REPO_CAP = 80;

function contribYear(query) {
  const nowY = new Date().getUTCFullYear();
  const y = Number(query);
  if (!Number.isInteger(y) || y < 2000 || y > nowY + 1) return nowY;
  return y;
}

function yearWindow(year) {
  return {
    since: `${year}-01-01`,
    until: `${year + 1}-01-01`,
    startMs: Date.UTC(year, 0, 1),
    endMs: Date.UTC(year + 1, 0, 1),
  };
}

function dayFromIso(iso) {
  return String(iso).slice(0, 10);
}

function dayFromMs(ms) {
  return new Date(Number(ms)).toISOString().slice(0, 10);
}

function bumpDay(map, date, n = 1) {
  if (!date) return;
  map.set(date, (map.get(date) || 0) + n);
}

function serializeContributions(year, map) {
  const prefix = `${year}-`;
  const days = [];
  let total = 0;
  for (const [date, count] of [...map.entries()].sort()) {
    if (!date.startsWith(prefix)) continue;
    days.push({ date, count });
    total += count;
  }
  return { year, total, days };
}

async function collectCommitDays(repos, { since, until, authorEmail }) {
  const map = new Map();
  const slice = repos.slice(0, CONTRIB_REPO_CAP);
  await Promise.all(slice.map(async r => {
    const dates = await commitDates(r.space_uid, r.uid, { since, until, authorEmail });
    for (const d of dates) bumpDay(map, dayFromIso(d));
  }));
  return map;
}

function orgSummary(row) {
  return {
    uid: row.uid,
    avatar_url: row.avatar_data ? `/api/v1/avatars/space/${row.uid}` : '',
  };
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
    const flags = await viewerFlags(pool, space.uid, req.auth.user);
    if (!space.is_public && !flags.is_member) {
      res.status(403).json({ message: 'No access to this space' });
      return;
    }
    res.json({
      ...rowToSpace(space),
      ...flags,
      profile_readme: await profileReadmeStatus(pool, space.uid),
    });
  });

  api.patch('/spaces/:spaceUid', auth, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM spaces WHERE uid = $1', [req.params.spaceUid]);
    if (rows.length === 0) {
      res.status(404).json({ message: 'Space not found' });
      return;
    }
    const space = rows[0];
    if (space.is_personal) {
      res.status(400).json({ message: 'Edit the user profile instead' });
      return;
    }
    const flags = await viewerFlags(pool, space.uid, req.auth.user);
    if (!flags.can_manage) {
      res.status(403).json({ message: 'Only owners and admins can edit this organization' });
      return;
    }
    const description = req.body?.description !== undefined ? String(req.body.description) : space.description;
    const isPublic = req.body?.is_public !== undefined ? Boolean(req.body.is_public) : space.is_public;
    const { rows: updated } = await pool.query(
      'UPDATE spaces SET description = $1, is_public = $2, updated = $3 WHERE uid = $4 RETURNING *',
      [description, isPublic, now(), space.uid],
    );
    res.json({ ...rowToSpace(updated[0]), ...flags, profile_readme: await profileReadmeStatus(pool, space.uid) });
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

  api.get('/spaces/:spaceUid/members', auth, async (req, res) => {
    const { rows: spaces } = await pool.query('SELECT * FROM spaces WHERE uid = $1', [req.params.spaceUid]);
    if (spaces.length === 0) {
      res.status(404).json({ message: 'Space not found' });
      return;
    }
    const space = spaces[0];
    const flags = await viewerFlags(pool, space.uid, req.auth.user);
    if (!space.is_public && !flags.is_member) {
      res.status(403).json({ message: 'No access to this space' });
      return;
    }
    res.json(await listMembers(pool, space.uid));
  });

  api.post('/spaces/:spaceUid/members', auth, async (req, res) => {
    const { rows: spaces } = await pool.query('SELECT * FROM spaces WHERE uid = $1', [req.params.spaceUid]);
    if (spaces.length === 0) {
      res.status(404).json({ message: 'Space not found' });
      return;
    }
    const space = spaces[0];
    if (space.is_personal) {
      res.status(400).json({ message: 'Personal namespaces have a single owner' });
      return;
    }
    const flags = await viewerFlags(pool, space.uid, req.auth.user);
    if (!flags.can_manage) {
      res.status(403).json({ message: 'Only owners and admins can add members' });
      return;
    }
    const uid = String(req.body?.uid || '').trim();
    const role = String(req.body?.role || 'member');
    if (!ORG_ROLES.has(role) || role === 'owner') {
      res.status(400).json({ message: 'Role must be member or admin' });
      return;
    }
    if (flags.role === 'admin' && role !== 'member') {
      res.status(403).json({ message: 'Admins can only add members' });
      return;
    }
    const userRes = await pool.query('SELECT uid FROM users WHERE uid = $1', [uid]);
    if (userRes.rows.length === 0) {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    const existing = await pool.query(
      'SELECT role FROM space_members WHERE space_uid = $1 AND user_uid = $2',
      [space.uid, uid],
    );
    if (existing.rows.length > 0) {
      res.status(409).json({ message: 'User is already a member' });
      return;
    }
    await pool.query(
      'INSERT INTO space_members (space_uid, user_uid, role, created) VALUES ($1, $2, $3, $4)',
      [space.uid, uid, role, now()],
    );
    res.status(201).json(await listMembers(pool, space.uid));
  });

  api.patch('/spaces/:spaceUid/members/:userUid', auth, async (req, res) => {
    const { spaceUid, userUid } = req.params;
    const { rows: spaces } = await pool.query('SELECT * FROM spaces WHERE uid = $1', [spaceUid]);
    if (spaces.length === 0) {
      res.status(404).json({ message: 'Space not found' });
      return;
    }
    const space = spaces[0];
    if (space.is_personal) {
      res.status(400).json({ message: 'Personal namespaces have a single owner' });
      return;
    }
    const flags = await viewerFlags(pool, space.uid, req.auth.user);
    if (!flags.can_manage) {
      res.status(403).json({ message: 'Only owners and admins can change roles' });
      return;
    }
    const nextRole = String(req.body?.role || '');
    if (nextRole !== 'admin' && nextRole !== 'member') {
      res.status(400).json({ message: 'Role must be member or admin' });
      return;
    }
    const target = await pool.query(
      'SELECT role FROM space_members WHERE space_uid = $1 AND user_uid = $2',
      [space.uid, userUid],
    );
    if (target.rows.length === 0) {
      res.status(404).json({ message: 'Member not found' });
      return;
    }
    const current = target.rows[0].role;
    if (current === 'owner') {
      res.status(400).json({ message: 'Transfer ownership instead of changing an owner\'s role' });
      return;
    }
    if (flags.role === 'admin' && current !== 'member') {
      res.status(403).json({ message: 'Admins can only change members' });
      return;
    }
    await pool.query(
      'UPDATE space_members SET role = $1 WHERE space_uid = $2 AND user_uid = $3',
      [nextRole, space.uid, userUid],
    );
    res.json(await listMembers(pool, space.uid));
  });

  api.delete('/spaces/:spaceUid/members/:userUid', auth, async (req, res) => {
    const { spaceUid, userUid } = req.params;
    const { rows: spaces } = await pool.query('SELECT * FROM spaces WHERE uid = $1', [spaceUid]);
    if (spaces.length === 0) {
      res.status(404).json({ message: 'Space not found' });
      return;
    }
    const space = spaces[0];
    if (space.is_personal) {
      res.status(400).json({ message: 'Personal namespaces have a single owner' });
      return;
    }
    const flags = await viewerFlags(pool, space.uid, req.auth.user);
    if (!flags.can_manage) {
      res.status(403).json({ message: 'Only owners and admins can remove members' });
      return;
    }
    const target = await pool.query(
      'SELECT role FROM space_members WHERE space_uid = $1 AND user_uid = $2',
      [space.uid, userUid],
    );
    if (target.rows.length === 0) {
      res.status(404).json({ message: 'Member not found' });
      return;
    }
    const current = target.rows[0].role;
    if (current === 'owner') {
      if (await ownerCount(pool, space.uid) <= 1) {
        res.status(400).json({ message: 'Transfer ownership before removing the last owner' });
        return;
      }
      if (flags.role === 'admin' && !req.auth.user.admin) {
        res.status(403).json({ message: 'Admins cannot remove owners' });
        return;
      }
    } else if (flags.role === 'admin' && current !== 'member') {
      res.status(403).json({ message: 'Admins can only remove members' });
      return;
    }
    await pool.query(
      'DELETE FROM space_members WHERE space_uid = $1 AND user_uid = $2',
      [space.uid, userUid],
    );
    res.json(await listMembers(pool, space.uid));
  });

  api.post('/spaces/:spaceUid/transfer', auth, async (req, res) => {
    const { rows: spaces } = await pool.query('SELECT * FROM spaces WHERE uid = $1', [req.params.spaceUid]);
    if (spaces.length === 0) {
      res.status(404).json({ message: 'Space not found' });
      return;
    }
    const space = spaces[0];
    if (space.is_personal) {
      res.status(400).json({ message: 'Personal namespaces cannot be transferred' });
      return;
    }
    const flags = await viewerFlags(pool, space.uid, req.auth.user);
    if (!flags.can_transfer) {
      res.status(403).json({ message: 'Only an owner can transfer this organization' });
      return;
    }
    const uid = String(req.body?.uid || '').trim();
    if (!uid || uid === req.auth.user.uid) {
      res.status(400).json({ message: 'Transfer to a different existing user' });
      return;
    }
    const userRes = await pool.query('SELECT uid FROM users WHERE uid = $1', [uid]);
    if (userRes.rows.length === 0) {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    const ts = now();
    await pool.query(
      `INSERT INTO space_members (space_uid, user_uid, role, created)
       VALUES ($1, $2, 'owner', $3)
       ON CONFLICT (space_uid, user_uid) DO UPDATE SET role = 'owner'`,
      [space.uid, uid, ts],
    );
    if (flags.role === 'owner') {
      await pool.query(
        `UPDATE space_members SET role = 'admin' WHERE space_uid = $1 AND user_uid = $2`,
        [space.uid, req.auth.user.uid],
      );
    }
    await pool.query(
      'UPDATE spaces SET created_by = $1, updated = $2 WHERE uid = $3',
      [uid, ts, space.uid],
    );
    const next = await viewerFlags(pool, space.uid, req.auth.user);
    const { rows: updated } = await pool.query('SELECT * FROM spaces WHERE uid = $1', [space.uid]);
    res.json({
      ...rowToSpace(updated[0]),
      ...next,
      profile_readme: await profileReadmeStatus(pool, space.uid),
      members: await listMembers(pool, space.uid),
    });
  });

  api.get('/spaces/:spaceUid/contributions', auth, async (req, res) => {
    const { rows: spaces } = await pool.query('SELECT * FROM spaces WHERE uid = $1', [req.params.spaceUid]);
    if (spaces.length === 0) {
      res.status(404).json({ message: 'Space not found' });
      return;
    }
    const space = spaces[0];
    const member = await canAccessSpace(pool, space.uid, req.auth.user);
    if (!space.is_public && !member) {
      res.status(403).json({ message: 'No access to this space' });
      return;
    }
    const year = contribYear(req.query.year);
    const { since, until, startMs, endMs } = yearWindow(year);
    const { rows: repos } = await pool.query(
      `SELECT * FROM repos WHERE space_uid = $1 ${member ? '' : 'AND is_public = TRUE'} ORDER BY uid`,
      [space.uid],
    );
    const map = await collectCommitDays(repos, { since, until });
    const prs = await pool.query(
      `SELECT pr.created FROM pull_requests pr
       JOIN repos r ON r.id = pr.repo_id
       WHERE r.space_uid = $1 AND pr.created >= $2 AND pr.created < $3
         ${member ? '' : 'AND r.is_public = TRUE'}`,
      [space.uid, startMs, endMs],
    );
    for (const p of prs.rows) bumpDay(map, dayFromMs(p.created));
    res.json(serializeContributions(year, map));
  });

  api.post('/repos', auth, async (req, res) => {
    const spaceUid = String(req.body?.parent_ref || '');
    const uid = String(req.body?.uid || '').trim();
    const description = String(req.body?.description || '');
    const isPublic = req.body?.is_public !== false;
    const readme = req.body?.readme !== false;
    const defaultBranch = String(req.body?.default_branch || 'main');
    const readmeContent = req.body?.readmeContent ? String(req.body.readmeContent) : undefined;

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
          content: readmeContent,
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

  api.post('/repos/:space/:repo/\\+/transfer', auth, async (req, res) => {
    const repo = await findRepo(pool, `${req.params.space}/${req.params.repo}`);
    if (!repo) {
      res.status(404).json({ message: 'Repository not found' });
      return;
    }
    if (!(await canWriteRepo(pool, repo.space_uid, req.auth.user))) {
      res.status(403).json({ message: 'No write access' });
      return;
    }
    const destSpace = String(req.body?.space || '').trim();
    const destUid = String(req.body?.uid || repo.uid).trim();
    if (!validRefSegment(destSpace) || !validRefSegment(destUid)) {
      res.status(400).json({ message: 'Invalid destination' });
      return;
    }
    if (destSpace === repo.space_uid && destUid === repo.uid) {
      res.status(400).json({ message: 'Pick a different space or name' });
      return;
    }
    const dest = await pool.query('SELECT uid FROM spaces WHERE uid = $1', [destSpace]);
    if (dest.rows.length === 0) {
      res.status(404).json({ message: 'Destination space not found' });
      return;
    }
    if (!(await canWriteRepo(pool, destSpace, req.auth.user))) {
      res.status(403).json({ message: 'No write access to the destination' });
      return;
    }
    const clash = await pool.query(
      'SELECT id FROM repos WHERE space_uid = $1 AND uid = $2',
      [destSpace, destUid],
    );
    if (clash.rows.length > 0) {
      res.status(409).json({ message: 'A repository already exists at that path' });
      return;
    }

    const fromPath = `${repo.space_uid}/${repo.uid}`;
    const toPath = `${destSpace}/${destUid}`;
    try {
      await moveBareRepo(repo.space_uid, repo.uid, destSpace, destUid);
    } catch (err) {
      console.error('moveBareRepo failed:', err.message);
      res.status(502).json({ message: err.message || 'Failed to move git repository' });
      return;
    }

    try {
      const { rows } = await pool.query(
        'UPDATE repos SET space_uid = $1, uid = $2, updated = $3 WHERE id = $4 RETURNING *',
        [destSpace, destUid, now(), repo.id],
      );
      await pool.query(
        'UPDATE conversations SET repo_path = $1 WHERE repo_path = $2',
        [toPath, fromPath],
      );
      await pool.query(
        `UPDATE prefs
         SET value = jsonb_set(
           value,
           '{repoProfiles}',
           (COALESCE(value->'repoProfiles', '{}'::jsonb) - $1)
             || jsonb_build_object($2::text, value->'repoProfiles'->$1)
         )
         WHERE key = 'assistant_profiles' AND value->'repoProfiles' ? $1`,
        [fromPath, toPath],
      );
      res.json(rowToRepo(rows[0]));
    } catch (err) {
      console.error('repo transfer metadata failed:', err.message);
      await moveBareRepo(destSpace, destUid, repo.space_uid, repo.uid).catch(() => {});
      res.status(500).json({ message: 'Failed to transfer repository' });
    }
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
    const profileReadme = await profileReadmeStatus(pool, u.uid);
    const orgsRes = await pool.query(
      `SELECT s.* FROM spaces s
       JOIN space_members sm ON sm.space_uid = s.uid
       WHERE sm.user_uid = $1 AND s.is_personal = FALSE
       ORDER BY s.uid`,
      [u.uid],
    );
    const orgs = orgsRes.rows
      .filter(s => s.is_public || canSeeAll)
      .map(orgSummary);
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
      socials: Array.isArray(u.socials) ? u.socials : [],
      profile_readme: profileReadme,
      created: Number(u.created),
      orgs,
      repos: reposRes.rows.map(r => rowToRepo(r, { openPulls: counts.get(Number(r.id)) ?? 0 })),
    });
  });

  // User goals: private onboarding nudges visible only to the user. Computing
  // reads the profile README, socials, and whether they've pushed anywhere.
  api.get('/users/:uid/goals', auth, async (req, res) => {
    const uid = String(req.params.uid);
    if (req.auth.user.uid !== uid && !req.auth.user.admin) {
      res.status(403).json({ message: 'Goals are private to the user' });
      return;
    }
    const uRes = await pool.query('SELECT * FROM users WHERE uid = $1', [uid]);
    if (uRes.rows.length === 0) {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    const u = uRes.rows[0];
    const socials = Array.isArray(u.socials) ? u.socials.filter(s => s && s.url) : [];
    const socialCount = socials.length;

    const readmeStatus = await profileReadmeStatus(pool, uid);

    // Personal repos: anything in the user's own namespace.
    const personalRes = await pool.query('SELECT * FROM repos WHERE space_uid = $1', [uid]);
    // Org repos: repos in non-personal spaces the user belongs to.
    const memberRes = await pool.query(
      `SELECT sm.space_uid FROM space_members sm
       JOIN spaces s ON s.uid = sm.space_uid
       WHERE sm.user_uid = $1 AND s.is_personal = FALSE`,
      [uid],
    );
    const orgSpaceUids = memberRes.rows.map(r => r.space_uid);
    const orgRes =
      orgSpaceUids.length > 0
        ? await pool.query('SELECT * FROM repos WHERE space_uid = ANY($1)', [orgSpaceUids])
        : { rows: [] };

    const personalCommit = await userCommitted(pool, personalRes.rows, u.email);
    const orgCommit = await userCommitted(pool, orgRes.rows, u.email);

    res.json({
      goals: [
        {
          id: 'profile_readme',
          label: 'Create a README for your profile',
          current: readmeStatus.hasReadme ? 1 : 0,
          target: 1,
          done: readmeStatus.hasReadme,
          repo: readmeStatus.repo,
        },
        {
          id: 'socials',
          label: 'Link your socials',
          current: Math.min(socialCount, 3),
          target: 3,
          done: socialCount >= 3,
          count: socialCount,
        },
        {
          id: 'personal_commit',
          label: 'Commit on a personal repository',
          current: personalCommit ? 1 : 0,
          target: 1,
          done: personalCommit,
        },
        {
          id: 'org_commit',
          label: 'Commit on an organization',
          current: orgCommit ? 1 : 0,
          target: 1,
          done: orgCommit,
        },
      ],
    });
  });

  api.get('/users/:uid/contributions', auth, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM users WHERE uid = $1', [req.params.uid]);
    if (rows.length === 0) {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    const u = rows[0];
    const canSeeAll = req.auth.user.admin || req.auth.user.uid === u.uid;
    const year = contribYear(req.query.year);
    const { since, until, startMs, endMs } = yearWindow(year);

    const memberRes = await pool.query(
      `SELECT sm.space_uid FROM space_members sm
       JOIN spaces s ON s.uid = sm.space_uid
       WHERE sm.user_uid = $1 AND s.is_personal = FALSE`,
      [u.uid],
    );
    const spaceUids = [u.uid, ...memberRes.rows.map(r => r.space_uid)];
    const reposRes = await pool.query(
      `SELECT * FROM repos WHERE space_uid = ANY($1) ${canSeeAll ? '' : 'AND is_public = TRUE'} ORDER BY uid`,
      [spaceUids],
    );
    const map = await collectCommitDays(reposRes.rows, { since, until, authorEmail: u.email });
    const prs = await pool.query(
      `SELECT pr.created FROM pull_requests pr
       JOIN repos r ON r.id = pr.repo_id
       WHERE pr.author_uid = $1 AND pr.created >= $2 AND pr.created < $3
         ${canSeeAll ? '' : 'AND r.is_public = TRUE'}`,
      [u.uid, startMs, endMs],
    );
    for (const p of prs.rows) bumpDay(map, dayFromMs(p.created));
    res.json(serializeContributions(year, map));
  });

  return api;
}

export { findRepo };
