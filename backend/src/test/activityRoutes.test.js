// Dashboard activity feed: git commits grouped into pushes and attributed to
// Nixre users by email, PR/star/deploy events merged in, and the visibility
// rules of canReadRepo applied before anything is read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

const root = mkdtempSync(path.join(tmpdir(), 'nixre-activity-'));
process.env.REPOS_ROOT = root;

// REPOS_ROOT is read at module load, so the git layer must be imported after it is set.
const { activityRoutes } = await import('../routes/activity.js');

const dir = path.join(root, 'acme', 'web.git');
mkdirSync(dir, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
git('init', '-q', '-b', 'main');
for (const [n, email, name] of [[1, 'ada@example.com', 'Ada'], [2, 'ada@example.com', 'Ada'], [3, 'stranger@example.com', 'Stranger']]) {
  writeFileSync(path.join(dir, `f${n}.txt`), `${n}\n`);
  git('add', '-A');
  git('-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', `commit ${n}`);
}

const now = Date.now();

function fixturePool(log) {
  return {
    async query(sql, params = []) {
      log.push({ sql, params });
      if (sql.includes('FROM repos r')) {
        return { rows: [{ id: 1, space_uid: 'acme', uid: 'web', created: now - 1000, created_by: 'ada', updated: now }] };
      }
      if (sql.includes('FROM users')) {
        return { rows: [
          { uid: 'ada', email: 'Ada@Example.com', display_name: 'Ada L', created: now - 2000, has_avatar: true },
          { uid: 'bob', email: 'bob@example.com', display_name: 'Bob', created: now - 90 * 86400000, has_avatar: false },
        ] };
      }
      if (sql.includes('COUNT(*)')) return { rows: [{ n: 2 }] };
      if (sql.includes('FROM pull_requests')) {
        return { rows: [{ repo_id: 1, number: 7, title: 'Ship it', state: 'merged', is_draft: false, author_uid: 'bob', merged_by_uid: 'ada', created: now - 5000, updated: now - 100, merged: now - 100 }] };
      }
      if (sql.includes('FROM repo_stars')) return { rows: [{ repo_id: 1, user_uid: 'bob', created: now - 300 }] };
      if (sql.includes('FROM deployments')) {
        return { rows: [{ id: 9, ref: 'main', sha: 'abcdef1234', status: 'failed', trigger_kind: 'push', started: now - 400, finished: now - 200, duration_ms: 1200, service_name: 'web', repo_id: 1 }] };
      }
      if (sql.includes('FROM workflow_runs')) return { rows: [] };
      return { rows: [] };
    },
  };
}

async function serve(t, pool, user) {
  const app = express();
  const auth = () => (req, _res, next) => { if (user) req.auth = { user }; next(); };
  app.use('/api/v1', activityRoutes(pool, auth));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/activity`);
  return { status: res.status, json: await res.json() };
}

test('merges git, PR, star and deploy events newest first', async t => {
  const log = [];
  const { status, json } = await serve(t, fixturePool(log), { uid: 'ada', admin: false });
  assert.equal(status, 200);

  const kinds = json.events.map(e => e.kind);
  for (const k of ['push', 'pr_opened', 'pr_merged', 'star', 'deploy_failed', 'repo_created', 'user_joined']) {
    assert.ok(kinds.includes(k), `missing ${k}`);
  }
  const ats = json.events.map(e => e.at);
  assert.deepEqual(ats, [...ats].sort((a, b) => b - a));

  // Ada's two commits collapse into one push, linked case-insensitively by email.
  const adaPush = json.events.find(e => e.kind === 'push' && e.actor.uid === 'ada');
  assert.equal(adaPush.count, 2);
  assert.equal(adaPush.actor.avatar_url, '/api/v1/avatars/user/ada');
  assert.equal(adaPush.repo, 'acme/web');
  const stranger = json.events.find(e => e.kind === 'push' && e.actor.uid === null);
  assert.equal(stranger.actor.display_name, 'Stranger');
  assert.equal(JSON.stringify(json).includes('@example.com'), false, 'emails never leave the server');

  assert.equal(json.events.find(e => e.kind === 'pr_merged').actor.uid, 'ada');
  assert.ok(!json.events.some(e => e.kind === 'user_joined' && e.actor.uid === 'bob'), 'old signups fall outside the window');

  assert.equal(json.daily.length, 30);
  const today = json.daily.at(-1);
  assert.equal(today.commits, 3);
  assert.equal(today.prs, 2);
  assert.equal(json.stats.commits_7d, 3);
  assert.equal(json.stats.open_prs, 2);
  assert.equal(json.stats.members, 2);
  assert.equal(json.contributors[0].uid, 'ada');
  // 'Active of N members' only counts accounts; git authors without one (Stranger) are reported apart,
  // so the first number can never exceed the member total.
  const accounts = new Set(json.contributors.filter(c => c.uid).map(c => c.uid));
  assert.equal(json.stats.contributors_7d, accounts.size);
  assert.equal(json.stats.external_contributors_7d, 1);
  assert.ok(json.stats.contributors_7d <= json.stats.members);

  // Member visibility is resolved in SQL against the viewer's uid.
  const repoQuery = log.find(q => q.sql.includes('FROM repos r'));
  assert.match(repoQuery.sql, /r\.is_public OR EXISTS/);
  assert.deepEqual(repoQuery.params, ['ada']);
});

test('guests only see public repos and never who joined', async t => {
  const log = [];
  const { json } = await serve(t, fixturePool(log), null);
  const repoQuery = log.find(q => q.sql.includes('FROM repos r'));
  assert.match(repoQuery.sql, /WHERE r\.is_public ORDER/);
  assert.ok(!json.events.some(e => e.kind === 'user_joined'));
  assert.equal(json.stats.members, null);
});

test('blocked users get an empty feed without touching the database', async t => {
  const log = [];
  const { json } = await serve(t, fixturePool(log), { uid: 'x', blocked: true });
  assert.equal(json.events.length, 0);
  assert.equal(log.length, 0);
});
