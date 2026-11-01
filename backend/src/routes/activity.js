// Instance-wide activity feed for the dashboard: commits, pull requests,
// stars, deployments, workflow runs and new repos/people, merged into one
// timeline. Everything is scoped to the repos the viewer can read (the same
// rules as lib/repoAccess.js canReadRepo, expressed as SQL).

import express from 'express';
import crypto from 'node:crypto';
import { recentCommits } from '../git/repo.js';
import { claimedOwners } from '../lib/userEmails.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const COMMIT_REPO_CAP = 25;     // git log is per repo; scan the freshest ones
const COMMITS_PER_REPO = 200;
const SAMPLE_COMMITS = 3;       // commits shown inline on a grouped push

function viewer(req) {
  return req.auth?.user ?? null;
}

function userAvatar(row) {
  return row.has_avatar ? `/api/v1/avatars/user/${row.uid}` : '';
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// WHERE clause over `repos r` matching canReadRepo.
function readableReposQuery(user) {
  if (!user) return { where: 'r.is_public', params: [] };
  if (user.admin) return { where: 'TRUE', params: [] };
  return {
    where: `r.is_public OR EXISTS (
      SELECT 1 FROM space_members m WHERE m.space_uid = r.space_uid AND m.user_uid = $1)`,
    params: [user.uid],
  };
}

// Group a single author's commits to one repo on one day into a "push".
function groupCommits(repo, commits, byEmail, keys) {
  const groups = new Map();
  for (const c of commits) {
    const at = Date.parse(c.when);
    if (!Number.isFinite(at)) continue;
    const user = byEmail.get(String(c.email).toLowerCase());
    // A person without an account is identified by email, not by however they spelled their name.
    const actorKey = user ? `u:${user.uid}` : `g:${String(c.email).toLowerCase() || c.name}`;
    // The id goes to clients, so an outsider's email is hashed, never embedded.
    const publicKey = user ? actorKey : `g:${crypto.createHash('sha1').update(actorKey).digest('hex').slice(0, 10)}`;
    const key = `${actorKey}|${isoDay(at)}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        id: `push:${repo.id}:${publicKey}|${isoDay(at)}`,
        kind: 'push',
        at,
        actor: user
          ? { uid: user.uid, display_name: user.display_name, avatar_url: userAvatar(user) }
          : { uid: null, display_name: c.name || 'unknown', avatar_url: '' },
        repo: repo.path,
        count: 0,
        commits: [],
      };
      groups.set(key, g);
      keys.set(g.id, actorKey);
    }
    g.count += 1;
    g.at = Math.max(g.at, at);
    if (g.commits.length < SAMPLE_COMMITS) g.commits.push({ sha: c.sha, short_sha: c.short_sha, title: c.title });
  }
  return [...groups.values()];
}

export function activityRoutes(pool, authenticate) {
  const api = express.Router();
  const optionalAuth = authenticate(false);

  api.get('/activity', optionalAuth, async (req, res) => {
    const user = viewer(req);
    const limit = Math.min(150, Math.max(1, Number.parseInt(req.query.limit, 10) || 60));
    const now = Date.now();
    const since = now - WINDOW_DAYS * DAY_MS;
    const weekAgo = now - 7 * DAY_MS;

    const empty = {
      window_days: WINDOW_DAYS,
      events: [],
      daily: [],
      contributors: [],
      stats: { repos: 0, open_prs: 0, commits_7d: 0, contributors_7d: 0, live_services: 0, members: null },
    };
    if (user?.blocked) {
      res.json(empty);
      return;
    }

    const vis = readableReposQuery(user);
    const { rows: repoRows } = await pool.query(
      `SELECT r.id, r.space_uid, r.uid, r.created, r.created_by, r.updated
         FROM repos r WHERE ${vis.where} ORDER BY r.updated DESC`,
      vis.params,
    );
    const repos = repoRows.map(r => ({ ...r, id: Number(r.id), path: `${r.space_uid}/${r.uid}` }));
    const repoById = new Map(repos.map(r => [r.id, r]));
    const ids = repos.map(r => r.id);

    // Every user that can show up as an actor, keyed by uid and by email.
    const { rows: userRows } = await pool.query(
      `SELECT uid, email, display_name, created, (avatar_data IS NOT NULL) AS has_avatar
         FROM users WHERE NOT blocked`,
    );
    const byUid = new Map(userRows.map(u => [u.uid, u]));
    const byEmail = new Map(userRows.map(u => [String(u.email).toLowerCase(), u]));
    // Extra emails an account has claimed; a primary address always wins.
    for (const [email, owner] of await claimedOwners(pool)) {
      if (byUid.has(owner) && !byEmail.has(email)) byEmail.set(email, byUid.get(owner));
    }
    const actorKeys = new Map(); // event id -> who, for the leaderboard (never sent to clients)
    const actor = uid => {
      const u = byUid.get(uid);
      if (!u) return uid ? { uid, display_name: uid, avatar_url: '' } : null;
      return { uid: u.uid, display_name: u.display_name, avatar_url: userAvatar(u) };
    };

    const events = [];
    // [ms, bucket] pairs for the 30-day chart; a push counts every commit.
    const ticks = [];

    // Commits, straight from git.
    const sinceIso = new Date(since).toISOString();
    const commitLists = await Promise.all(
      repos.slice(0, COMMIT_REPO_CAP).map(async r => [r, await recentCommits(r.space_uid, r.uid, { since: sinceIso, limit: COMMITS_PER_REPO })]),
    );
    let commits7d = 0;
    for (const [r, commits] of commitLists) {
      for (const c of commits) {
        const at = Date.parse(c.when);
        if (!Number.isFinite(at) || at < since) continue;
        ticks.push([at, 'commits']);
        if (at >= weekAgo) commits7d += 1;
      }
      events.push(...groupCommits(r, commits.filter(c => Date.parse(c.when) >= since), byEmail, actorKeys));
    }

    if (ids.length) {
      const prs = await pool.query(
        `SELECT repo_id, number, title, state, is_draft, author_uid, merged_by_uid, created, updated, merged
           FROM pull_requests
          WHERE repo_id = ANY($1) AND (created >= $2 OR merged >= $2 OR (state = 'closed' AND updated >= $2))
          ORDER BY GREATEST(created, COALESCE(merged, 0), updated) DESC
          LIMIT 200`,
        [ids, since],
      );
      for (const pr of prs.rows) {
        const repo = repoById.get(Number(pr.repo_id));
        const base = { repo: repo.path, number: Number(pr.number), title: pr.title, draft: Boolean(pr.is_draft) };
        const created = Number(pr.created);
        if (created >= since) {
          events.push({ id: `pr:${pr.repo_id}:${pr.number}:open`, kind: 'pr_opened', at: created, actor: actor(pr.author_uid), ...base });
          ticks.push([created, 'prs']);
        }
        if (pr.state === 'merged' && pr.merged != null && Number(pr.merged) >= since) {
          events.push({ id: `pr:${pr.repo_id}:${pr.number}:merge`, kind: 'pr_merged', at: Number(pr.merged), actor: actor(pr.merged_by_uid || pr.author_uid), ...base });
          ticks.push([Number(pr.merged), 'prs']);
        }
        if (pr.state === 'closed' && Number(pr.updated) >= since) {
          events.push({ id: `pr:${pr.repo_id}:${pr.number}:close`, kind: 'pr_closed', at: Number(pr.updated), actor: actor(pr.author_uid), ...base });
          ticks.push([Number(pr.updated), 'prs']);
        }
      }

      const stars = await pool.query(
        `SELECT repo_id, user_uid, created FROM repo_stars
          WHERE repo_id = ANY($1) AND created >= $2 ORDER BY created DESC LIMIT 100`,
        [ids, since],
      );
      for (const s of stars.rows) {
        const repo = repoById.get(Number(s.repo_id));
        events.push({ id: `star:${s.repo_id}:${s.user_uid}`, kind: 'star', at: Number(s.created), actor: actor(s.user_uid), repo: repo.path });
        ticks.push([Number(s.created), 'other']);
      }

      const deploys = await pool.query(
        `SELECT d.id, d.ref, d.sha, d.status, d.trigger_kind, d.started, d.finished, d.duration_ms,
                s.name AS service_name, s.repo_id
           FROM deployments d JOIN deploy_services s ON s.id = d.service_id
          WHERE s.repo_id = ANY($1) AND d.started >= $2 AND d.status IN ('live', 'failed')
          ORDER BY d.started DESC LIMIT 100`,
        [ids, since],
      );
      for (const d of deploys.rows) {
        const repo = repoById.get(Number(d.repo_id));
        const at = Number(d.finished ?? d.started);
        events.push({
          id: `deploy:${d.id}`,
          kind: d.status === 'live' ? 'deploy_live' : 'deploy_failed',
          at,
          actor: null,
          repo: repo.path,
          service: d.service_name,
          ref: d.ref,
          short_sha: String(d.sha || '').slice(0, 7),
          trigger: d.trigger_kind,
          duration_ms: d.duration_ms == null ? null : Number(d.duration_ms),
        });
        ticks.push([at, 'other']);
      }

      const runs = await pool.query(
        `SELECT id, repo_id, run_number, workflow_name, event, ref, sha, actor, conclusion, created, finished
           FROM workflow_runs
          WHERE repo_id = ANY($1) AND status = 'completed' AND COALESCE(finished, created) >= $2
            AND conclusion IN ('success', 'failure')
          ORDER BY COALESCE(finished, created) DESC LIMIT 100`,
        [ids, since],
      );
      for (const r of runs.rows) {
        const repo = repoById.get(Number(r.repo_id));
        const at = Number(r.finished ?? r.created);
        events.push({
          id: `run:${r.id}`,
          kind: r.conclusion === 'success' ? 'run_success' : 'run_failure',
          at,
          actor: r.actor ? actor(r.actor) : null,
          repo: repo.path,
          workflow: r.workflow_name,
          run_number: Number(r.run_number),
          ref: String(r.ref || '').replace(/^refs\/(heads|tags)\//, ''),
          short_sha: String(r.sha || '').slice(0, 7),
        });
        ticks.push([at, 'other']);
      }
    }

    for (const r of repos) {
      const created = Number(r.created);
      if (created < since) continue;
      events.push({ id: `repo:${r.id}`, kind: 'repo_created', at: created, actor: actor(r.created_by), repo: r.path });
      ticks.push([created, 'other']);
    }

    // Who joined is only shown to signed-in people; guests see repo activity.
    if (user) {
      for (const u of userRows) {
        const created = Number(u.created);
        if (created < since) continue;
        events.push({ id: `user:${u.uid}`, kind: 'user_joined', at: created, actor: actor(u.uid) });
        ticks.push([created, 'other']);
      }
    }

    events.sort((a, b) => b.at - a.at);

    // Daily buckets, oldest first, one per day including today.
    const days = new Map();
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      days.set(isoDay(now - i * DAY_MS), { date: isoDay(now - i * DAY_MS), commits: 0, prs: 0, other: 0 });
    }
    for (const [at, bucket] of ticks) {
      const day = days.get(isoDay(at));
      if (day) day[bucket] += 1;
    }

    // Leaderboard for the last 7 days; a push weighs as many commits as it has.
    const board = new Map();
    for (const e of events) {
      if (e.at < weekAgo || !e.actor || e.kind === 'user_joined') continue;
      const key = actorKeys.get(e.id) ?? (e.actor.uid ? `u:${e.actor.uid}` : `g:${e.actor.display_name}`);
      const entry = board.get(key) || { ...e.actor, count: 0, commits: 0, prs: 0 };
      const weight = e.kind === 'push' ? e.count : 1;
      entry.count += weight;
      if (e.kind === 'push') entry.commits += e.count;
      if (e.kind.startsWith('pr_')) entry.prs += 1;
      board.set(key, entry);
    }
    const contributors = [...board.values()].sort((a, b) => b.count - a.count).slice(0, 6);
    // `board` is keyed by who made the change: a Nixre account when the commit email matches one,
    // otherwise the author's email. Only accounts can be compared with `members`.
    const accounts = new Set([...board.values()].filter(c => c.uid).map(c => c.uid));
    const external = board.size - accounts.size;
    // Whoever pushed this week is active too, whatever name their commits carry.
    if (repos.length) {
      const { rows: pushers } = await pool.query(
        `SELECT DISTINCT p.user_uid FROM push_events p JOIN users u ON u.uid = p.user_uid
          WHERE p.created >= $1 AND NOT u.blocked AND (p.space || '/' || p.repo) = ANY($2)`,
        [weekAgo, repos.map(r => r.path)],
      );
      for (const p of pushers) accounts.add(p.user_uid);
    }

    let openPrs = 0;
    let liveServices = 0;
    if (ids.length) {
      const [{ rows: prCount }, { rows: svcCount }] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS n FROM pull_requests WHERE repo_id = ANY($1) AND state = 'open'`, [ids]),
        pool.query(`SELECT COUNT(*)::int AS n FROM deploy_services WHERE repo_id = ANY($1) AND status = 'running'`, [ids]),
      ]);
      openPrs = Number(prCount[0]?.n ?? 0);
      liveServices = Number(svcCount[0]?.n ?? 0);
    }

    res.json({
      window_days: WINDOW_DAYS,
      events: events.slice(0, limit),
      daily: [...days.values()],
      contributors,
      stats: {
        repos: repos.length,
        open_prs: openPrs,
        commits_7d: commits7d,
        contributors_7d: accounts.size,
        external_contributors_7d: external,
        live_services: liveServices,
        members: user ? userRows.length : null,
      },
    });
  });

  return api;
}
