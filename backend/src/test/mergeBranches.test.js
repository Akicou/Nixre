// mergeBranches against REAL git repositories.
//
// No mocks: every test creates a bare repo under a throwaway REPOS_ROOT, drives
// it with the git binary, and then calls the production merge path. The point is
// to establish — not assume — that a merge advances the target, preserves the
// source, records the caller's identity, and that a failing merge leaves the
// repository byte-for-byte as it was.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

const ROOT = await mkdtemp(path.join(os.tmpdir(), 'nixre-merge-'));
process.env.REPOS_ROOT = ROOT;
const { mergeBranches, repoDir } = await import('../git/repo.js');

const SPACE = 'space';
const IDENTITY = { authorName: 'Merge Bot', authorEmail: 'bot@nixre.test' };
let seq = 0;

async function g(dir, ...args) {
  const { stdout } = await exec('git', ['-C', dir, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Bare repo with `main` and a topic branch, built by real commits.
 * `plan` describes commits: { branch, files: {path: content}, message }.
 */
async function makeRepo(plan) {
  const name = `r${++seq}`;
  const bare = repoDir(SPACE, name);
  await exec('git', ['init', '--bare', '--initial-branch', 'main', bare]);
  const work = path.join(ROOT, `${name}-work`);
  await exec('git', ['clone', bare, work]);
  await g(work, 'config', 'user.name', 'Seed');
  await g(work, 'config', 'user.email', 'seed@nixre.test');
  for (const [i, step] of plan.entries()) {
    // A fresh clone of an empty bare repo has no branches at all, so the first
    // checkout (and every explicit branch creation) uses -B.
    await g(work, 'checkout', ...(step.create || i === 0 ? ['-B', step.branch] : [step.branch]));
    for (const [file, content] of Object.entries(step.files ?? {})) {
      await writeFile(path.join(work, file), content, 'utf8');
      await g(work, 'add', '--', file);
    }
    await g(work, 'commit', '-m', step.message);
  }
  await g(work, 'push', '--all', 'origin');
  return { name, bare, work };
}

const sha = (bare, ref) => g(bare, 'rev-parse', ref);

/** Temp clones mergeBranches makes live next to the bare repo; none may survive. */
async function strayDirs(name) {
  const entries = await readdir(path.join(ROOT, SPACE));
  return entries.filter(e => e.startsWith(`${name}.git-`));
}

test.after(() => rm(ROOT, { recursive: true, force: true }));

// --- happy paths ------------------------------------------------------------

test('merge: creates a merge commit, advances target, leaves source alone', async () => {
  const { name, bare } = await makeRepo([
    { branch: 'main', files: { 'a.txt': 'a\n' }, message: 'base' },
    { branch: 'feature', create: true, files: { 'b.txt': 'b\n' }, message: 'feature work' },
  ]);
  const before = await sha(bare, 'main');
  const sourceBefore = await sha(bare, 'feature');

  const result = await mergeBranches(SPACE, name, 'main', 'feature', 'merge', IDENTITY);

  const after = await sha(bare, 'main');
  assert.notEqual(after, before, 'target ref must advance');
  assert.equal(after, result.sha ?? result, 'returned sha must be the new target head');
  assert.equal(await sha(bare, 'feature'), sourceBefore, 'source branch must be untouched');
  // Two parents == a real merge commit, not a fast-forward.
  const parents = (await g(bare, 'rev-list', '--parents', '-n', '1', 'main')).split(/\s+/).slice(1);
  assert.equal(parents.length, 2);
  assert.deepEqual(parents.sort(), [before, sourceBefore].sort());
  assert.equal(await g(bare, 'cat-file', '-p', 'main:b.txt'), 'b');
  assert.deepEqual(await strayDirs(name), []);
});

test('merge: records the passed-in author and committer identity', async () => {
  const { name, bare } = await makeRepo([
    { branch: 'main', files: { 'a.txt': 'a\n' }, message: 'base' },
    { branch: 'feature', create: true, files: { 'b.txt': 'b\n' }, message: 'feature work' },
  ]);
  await mergeBranches(SPACE, name, 'main', 'feature', 'merge', IDENTITY);
  assert.equal(await g(bare, 'log', '-1', '--format=%an%x1f%ae%x1f%cn%x1f%ce', 'main'),
    'Merge Botbot@nixre.testMerge Botbot@nixre.test');
});

test('merge: a fast-forwardable branch still lands as an explicit merge commit', async () => {
  // main has not moved since feature branched, so git could fast-forward.
  const { name, bare } = await makeRepo([
    { branch: 'main', files: { 'a.txt': 'a\n' }, message: 'base' },
    { branch: 'feature', create: true, files: { 'a.txt': 'a\nmore\n' }, message: 'extend a' },
  ]);
  const before = await sha(bare, 'main');
  await mergeBranches(SPACE, name, 'main', 'feature', 'merge', IDENTITY);
  const parents = (await g(bare, 'rev-list', '--parents', '-n', '1', 'main')).split(/\s+/).slice(1);
  assert.equal(parents.length, 2, '--no-ff keeps the merge explicit and auditable');
  assert.equal(parents[0], before);
  assert.equal(await g(bare, 'cat-file', '-p', 'main:a.txt'), 'a\nmore');
});

test('merge: true three-way merge keeps both sides', async () => {
  const { name, bare, work } = await makeRepo([
    { branch: 'main', files: { 'a.txt': 'a\n' }, message: 'base' },
    { branch: 'feature', create: true, files: { 'b.txt': 'from feature\n' }, message: 'feature work' },
  ]);
  // main moves on independently after feature branched.
  await g(work, 'checkout', 'main');
  await writeFile(path.join(work, 'c.txt'), 'from main\n', 'utf8');
  await g(work, 'add', '--', 'c.txt');
  await g(work, 'commit', '-m', 'main work');
  await g(work, 'push', 'origin', 'main');

  await mergeBranches(SPACE, name, 'main', 'feature', 'merge', IDENTITY);
  assert.equal(await g(bare, 'cat-file', '-p', 'main:b.txt'), 'from feature');
  assert.equal(await g(bare, 'cat-file', '-p', 'main:c.txt'), 'from main');
});

test('squash: one commit, one parent, full source content, caller identity', async () => {
  const { name, bare } = await makeRepo([
    { branch: 'main', files: { 'a.txt': 'a\n' }, message: 'base' },
    { branch: 'feature', create: true, files: { 'b.txt': 'one\n' }, message: 'first' },
    { branch: 'feature', files: { 'b.txt': 'one\ntwo\n' }, message: 'second' },
  ]);
  const before = await sha(bare, 'main');
  const sourceBefore = await sha(bare, 'feature');

  await mergeBranches(SPACE, name, 'main', 'feature', 'squash', IDENTITY);

  const parents = (await g(bare, 'rev-list', '--parents', '-n', '1', 'main')).split(/\s+/).slice(1);
  assert.deepEqual(parents, [before], 'squash must produce a single-parent commit');
  assert.equal(await g(bare, 'cat-file', '-p', 'main:b.txt'), 'one\ntwo');
  assert.equal(await g(bare, 'log', '-1', '--format=%an%x1f%ae', 'main'), 'Merge Botbot@nixre.test');
  assert.equal(await sha(bare, 'feature'), sourceBefore);
  assert.deepEqual(await strayDirs(name), []);
});

// --- failure paths ----------------------------------------------------------

for (const method of ['merge', 'squash']) {
  test(`${method}: a conflict fails cleanly and leaves the repository untouched`, async () => {
    const { name, bare, work } = await makeRepo([
      { branch: 'main', files: { 'a.txt': 'base\n' }, message: 'base' },
      { branch: 'feature', create: true, files: { 'a.txt': 'feature side\n' }, message: 'feature edit' },
    ]);
    await g(work, 'checkout', 'main');
    await writeFile(path.join(work, 'a.txt'), 'main side\n', 'utf8');
    await g(work, 'add', '--', 'a.txt');
    await g(work, 'commit', '-m', 'main edit');
    await g(work, 'push', 'origin', 'main');

    const targetBefore = await sha(bare, 'main');
    const sourceBefore = await sha(bare, 'feature');
    const refsBefore = await g(bare, 'for-each-ref');

    await assert.rejects(
      () => mergeBranches(SPACE, name, 'main', 'feature', method, IDENTITY),
      err => {
        assert.equal(err.code, 'merge_conflict', 'conflicts must be distinguishable from other failures');
        assert.match(err.message, /conflict/i);
        return true;
      },
    );

    assert.equal(await sha(bare, 'main'), targetBefore, 'target ref must not move');
    assert.equal(await sha(bare, 'feature'), sourceBefore, 'source ref must not move');
    assert.equal(await g(bare, 'for-each-ref'), refsBefore, 'no ref may be added or changed');
    assert.deepEqual(await strayDirs(name), [], 'no half-merged temp clone may survive');
    // No merge state anywhere in the bare repo.
    const files = await readdir(bare);
    assert.ok(!files.includes('MERGE_HEAD'), 'bare repo must carry no merge state');
  });

  test(`${method}: an already fully merged branch is reported, not silently faked`, async () => {
    const { name, bare } = await makeRepo([
      { branch: 'main', files: { 'a.txt': 'a\n' }, message: 'base' },
      { branch: 'feature', create: true, files: { 'b.txt': 'b\n' }, message: 'feature work' },
    ]);
    await mergeBranches(SPACE, name, 'main', 'feature', method, IDENTITY);
    const afterFirst = await sha(bare, 'main');

    const result = await mergeBranches(SPACE, name, 'main', 'feature', method, IDENTITY);
    assert.equal(result.alreadyMerged, true);
    assert.equal(result.sha, afterFirst, 'a no-op merge must not invent a commit');
    assert.equal(await sha(bare, 'main'), afterFirst, 'target ref must not move on a no-op');
    assert.deepEqual(await strayDirs(name), []);
  });
}

test('merge: a missing source branch fails and changes nothing', async () => {
  const { name, bare } = await makeRepo([
    { branch: 'main', files: { 'a.txt': 'a\n' }, message: 'base' },
  ]);
  const before = await sha(bare, 'main');
  await assert.rejects(() => mergeBranches(SPACE, name, 'main', 'nope', 'merge', IDENTITY));
  assert.equal(await sha(bare, 'main'), before);
  assert.deepEqual(await strayDirs(name), []);
});

test('an unknown method is treated as a merge commit rather than silently dropped', async () => {
  const { name, bare } = await makeRepo([
    { branch: 'main', files: { 'a.txt': 'a\n' }, message: 'base' },
    { branch: 'feature', create: true, files: { 'b.txt': 'b\n' }, message: 'feature work' },
  ]);
  await mergeBranches(SPACE, name, 'main', 'feature', 'rebase-please', IDENTITY);
  const parents = (await g(bare, 'rev-list', '--parents', '-n', '1', 'main')).split(/\s+/).slice(1);
  assert.equal(parents.length, 2);
});
