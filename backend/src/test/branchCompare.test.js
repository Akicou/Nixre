// End-to-end (git on disk -> helper -> route -> JSON) checks for the three
// things the branch/commit/PR views need and used to be missing:
//   1. branch ahead/behind vs the default branch, in the API response
//   2. a commit's parents and its actual per-file patch
//   3. a pull request's ahead/behind
//
// Direction matters more than the numbers, so the fixture is deliberately
// lopsided: `feature` is 2 ahead and 3 behind `main`. A swapped pair fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

const root = mkdtempSync(path.join(tmpdir(), 'nixre-branch-'));
process.env.REPOS_ROOT = root;

// REPOS_ROOT is read at module load, so the git layer must be imported after it is set.
const { forgeRoutes } = await import('../routes/forge.js');
const { pullRequestRoutes } = await import('../routes/pullreq.js');

const dir = path.join(root, 'sp', 'r.git');
mkdirSync(dir, { recursive: true });

function git(...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

function commit(file, text, message) {
  writeFileSync(path.join(dir, file), text);
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD').trim();
}

git('init', '-q', '-b', 'main');
const baseSha = commit('base.txt', 'base\n', 'base commit');
// feature: 2 commits past the base
git('checkout', '-q', '-b', 'feature');
commit('feature.txt', 'one\n', 'feature one');
const featureTip = commit('feature.txt', 'one\ntwo\n', 'feature two');
// main: 3 commits past the base
git('checkout', '-q', 'main');
commit('main.txt', 'a\n', 'main a');
commit('main.txt', 'a\nb\n', 'main b');
commit('main.txt', 'a\nb\nc\n', 'main c');

async function serve(t) {
  const pool = {
    async query(sql) {
      if (sql.includes('FROM repos')) {
        return { rows: [{ id: 1, space_uid: 'sp', uid: 'r', is_public: true, default_branch: 'main' }] };
      }
      if (sql.includes('FROM pull_requests')) {
        return {
          rows: [{
            id: 1, repo_id: 1, number: 1, title: 'Feature', description: '', state: 'open',
            is_draft: false, source_branch: 'feature', target_branch: 'main',
            author_uid: 'owner', created: 1, updated: 1, merged: null,
          }],
        };
      }
      return { rows: [] };
    },
  };
  const app = express();
  app.use(express.json());
  const auth = () => (req, _res, next) => {
    req.auth = { user: { uid: 'owner', admin: true } };
    next();
  };
  app.use('/api/v1', forgeRoutes(pool, auth));
  app.use('/api/v1', pullRequestRoutes(pool, auth));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async p => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${p}`);
    return { status: res.status, json: await res.json() };
  };
}

test('branch list reports ahead/behind vs the default branch, not swapped', async t => {
  const request = await serve(t);
  const { status, json } = await request('/repos/sp/r/+/branches');
  assert.equal(status, 200);
  const byName = Object.fromEntries(json.branches.map(b => [b.name, b]));
  assert.deepEqual(Object.keys(byName).sort(), ['feature', 'main']);
  // feature has 2 commits main lacks, and lacks 3 commits main has.
  assert.equal(byName.feature.ahead, 2, 'feature should be 2 ahead of main');
  assert.equal(byName.feature.behind, 3, 'feature should be 3 behind main');
  assert.equal(byName.main.ahead, 0);
  assert.equal(byName.main.behind, 0);
});

test('commit detail exposes parents and the commit patch', async t => {
  const request = await serve(t);
  const { status, json } = await request(`/repos/sp/r/+/commits/${featureTip}`);
  assert.equal(status, 200);
  assert.equal(json.commit.sha, featureTip);
  assert.equal(json.commit.parents.length, 1);
  assert.match(json.commit.title, /feature two/);
  const file = json.files.find(f => f.path === 'feature.txt');
  assert.ok(file, 'the commit should list feature.txt');
  assert.equal(file.additions, 1);
  // Patch is base64 on the wire (ui/src/lib/diff.ts decodes it).
  const patch = Buffer.from(file.patch, 'base64').toString('utf8');
  assert.match(patch, /^\+two$/m, 'the added line should be in the patch');

  // Root commit has no parent: still resolves, just without a patch.
  const rootRes = await request(`/repos/sp/r/+/commits/${baseSha}`);
  assert.equal(rootRes.status, 200);
  assert.deepEqual(rootRes.json.commit.parents, []);
});

test('pull request detail reports ahead/behind for source vs target', async t => {
  const request = await serve(t);
  const { status, json } = await request('/repos/sp/r/+/pullreq/1');
  assert.equal(status, 200);
  assert.equal(json.source_branch, 'feature');
  assert.equal(json.target_branch, 'main');
  // ahead = commits on the source the target lacks; behind = the reverse.
  assert.equal(json.ahead, 2, 'PR should be 2 ahead');
  assert.equal(json.behind, 3, 'PR should be 3 behind');
});
