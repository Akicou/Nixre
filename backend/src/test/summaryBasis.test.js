// The basis an AI summary is built from must be "what is NOT yet in the target",
// resolved against the target's CURRENT head — never the branch's whole history.
//
// Scenario reproduced here is the reported one: a branch with 4 commits, 3 of
// which have already been merged into main. A summary generated afterwards must
// describe the 4th only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

const ROOT = await mkdtemp(path.join(os.tmpdir(), 'nixre-basis-'));
process.env.REPOS_ROOT = ROOT;
const { commitsAhead, diffRefs, mergeBranches, repoDir } = await import('../git/repo.js');

const SPACE = 'space';
const IDENTITY = { authorName: 'Merge Bot', authorEmail: 'bot@nixre.test' };

async function g(dir, ...args) {
  const { stdout } = await exec('git', ['-C', dir, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

test.after(() => rm(ROOT, { recursive: true, force: true }));

/**
 * main: base commit.
 * feature: c1..c4, each adding one file. Returns the sha of c3 so the test can
 * merge "a previous stand of the branch" into main, exactly as the user did.
 */
async function buildPartlyMergedRepo(name) {
  const bare = repoDir(SPACE, name);
  await exec('git', ['init', '--bare', '--initial-branch', 'main', bare]);
  const work = path.join(ROOT, `${name}-work`);
  await exec('git', ['clone', bare, work]);
  await g(work, 'config', 'user.name', 'Dev');
  await g(work, 'config', 'user.email', 'dev@nixre.test');
  await g(work, 'checkout', '-B', 'main');
  await writeFile(path.join(work, 'base.txt'), 'base\n', 'utf8');
  await g(work, 'add', '--', 'base.txt');
  await g(work, 'commit', '-m', 'base');
  await g(work, 'checkout', '-b', 'feature');
  for (const n of [1, 2, 3, 4]) {
    await writeFile(path.join(work, `c${n}.txt`), `commit ${n}\n`, 'utf8');
    await g(work, 'add', '--', `c${n}.txt`);
    await g(work, 'commit', '-m', `commit ${n}`);
  }
  const c3 = await g(work, 'rev-parse', 'feature~1');
  await g(work, 'push', '--all', 'origin');
  return { bare, work, c3 };
}

test('the summary basis is the whole branch while nothing has been merged', async () => {
  const { bare } = await buildPartlyMergedRepo('whole');
  const commits = await commitsAhead(SPACE, 'whole', 'main', 'feature');
  assert.deepEqual(commits.map(c => c.title), ['commit 4', 'commit 3', 'commit 2', 'commit 1']);
  const files = await diffRefs(SPACE, 'whole', 'main', 'feature');
  assert.deepEqual(files.map(f => f.path).sort(), ['c1.txt', 'c2.txt', 'c3.txt', 'c4.txt']);
  assert.ok(bare);
});

test('after a previous stand of the branch is merged, only the unmerged commit remains the basis', async () => {
  const name = 'partial';
  const { bare, work, c3 } = await buildPartlyMergedRepo(name);
  // Merge the branch as it stood at commit 3 into main — the "previous stand".
  await g(work, 'checkout', 'main');
  await g(work, 'merge', '--no-ff', '-m', 'Merge feature@c3', c3);
  await g(work, 'push', 'origin', 'main');

  const commits = await commitsAhead(SPACE, name, 'main', 'feature');
  assert.deepEqual(commits.map(c => c.title), ['commit 4'],
    'commits already in main must not be described again');

  const files = await diffRefs(SPACE, name, 'main', 'feature');
  assert.deepEqual(files.map(f => f.path), ['c4.txt'],
    'the diff basis must be target...source against the CURRENT target head');
  assert.ok(await g(bare, 'cat-file', '-p', 'main:c3.txt'));
});

test('a branch fully merged into the target has an empty basis', async () => {
  const name = 'fully';
  await buildPartlyMergedRepo(name);
  await mergeBranches(SPACE, name, 'main', 'feature', 'merge', IDENTITY);
  assert.deepEqual(await commitsAhead(SPACE, name, 'main', 'feature'), []);
  assert.deepEqual(await diffRefs(SPACE, name, 'main', 'feature'), []);
});

test('the basis follows the target head, so it shrinks without the source moving', async () => {
  const name = 'moving';
  const { work, c3 } = await buildPartlyMergedRepo(name);
  const sourceHead = await g(work, 'rev-parse', 'feature');
  assert.equal((await commitsAhead(SPACE, name, 'main', 'feature')).length, 4);

  await g(work, 'checkout', 'main');
  await g(work, 'merge', '--no-ff', '-m', 'Merge feature@c3', c3);
  await g(work, 'push', 'origin', 'main');

  assert.equal(await g(work, 'rev-parse', 'feature'), sourceHead, 'source did not move');
  assert.equal((await commitsAhead(SPACE, name, 'main', 'feature')).length, 1,
    'a cached basis from PR-creation time would still say 4');
});

test('commitsAhead rejects refs that are not valid branch names', async () => {
  await assert.rejects(() => commitsAhead(SPACE, 'whole', '--output=/tmp/x', 'feature'));
});
