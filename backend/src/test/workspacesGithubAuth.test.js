import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import { pool } from '../db/pool.js';
import { encryptSecret } from '../lib/ai.js';

// Capture a fake git executor before this isolated test worker loads workspaces.
const originalExec = childProcess.execFile;
let execute;
childProcess.execFile = () => {};
childProcess.execFile[promisify.custom] = (...args) => execute(...args);
syncBuiltinESMExports();
const { ensureGithubMirror } = await import('../lib/workspaces.js');
childProcess.execFile = originalExec;
syncBuiltinESMExports();

function setup(t, { exists = true } = {}) {
  process.env.AI_SECRET = 'test-github-secret-0123456789abcdef';
  delete process.env.AI_SECRET_LEGACY;
  const calls = [];
  t.mock.method(pool, 'query', async (_sql, params) => ({ rows: [{ secret_enc: encryptSecret(params[0] + '-token') }] }));
  t.mock.method(fs, 'access', async () => { if (!exists) throw new Error('missing mirror'); });
  t.mock.method(fs, 'stat', async () => ({ mtimeMs: Date.now() }));
  for (const method of ['mkdir', 'utimes', 'rm']) t.mock.method(fs, method, async () => {});
  execute = async (_file, args, options) => {
    calls.push({ args, token: options?.env?.NIXRE_GH_PAT });
    if (args.includes('ls-remote') && options.env.NIXRE_GH_PAT !== 'owner-token') throw new Error('upstream denied');
    return { stdout: '', stderr: '' };
  };
  return calls;
}

test('cached mirrors require a successful current-caller git read, not just a stored PAT', async t => {
  const calls = setup(t);
  const dir = await ensureGithubMirror('owner', 'org', 'cached-private');
  assert.match(dir, /cached-private\.git$/);
  for (const user of ['outsider', 'invalid-pat', 'revoked-pat', 'metadata-only-pat']) {
    await assert.rejects(ensureGithubMirror(user, 'org', 'cached-private'), err => err.status === 403);
  }
  assert.equal(calls.length, 5);
  assert.ok(calls.every(c => c.args.includes('ls-remote')));
});

test('missing mirrors are not provisioned for a caller who fails upstream authorization', async t => {
  const calls = setup(t, { exists: false });
  await assert.rejects(ensureGithubMirror('outsider', 'org', 'new-private'), err => err.status === 403);
  assert.equal(calls.length, 1);
  assert.equal(fs.mkdir.mock.callCount(), 0);
});

test('each pending-clone join is authorized and no partial mirror is returned', async t => {
  setup(t, { exists: false });
  let finishClone;
  let cloneStarted;
  const cloning = new Promise(resolve => { cloneStarted = resolve; });
  const gate = new Promise(resolve => { finishClone = resolve; });
  let clones = 0;
  const authTokens = [];
  execute = async (_file, args, options) => {
    if (args.includes('ls-remote')) {
      authTokens.push(options.env.NIXRE_GH_PAT);
      if (options.env.NIXRE_GH_PAT === 'outsider-token') throw new Error('upstream denied');
    }
    if (args.includes('clone')) {
      clones++;
      // Git creates the destination before the clone finishes.
      fs.access.mock.mockImplementation(async () => {});
      cloneStarted();
      await gate;
    }
    return { stdout: '', stderr: '' };
  };
  const first = ensureGithubMirror('owner', 'org', 'pending-private');
  await cloning;
  await assert.rejects(ensureGithubMirror('outsider', 'org', 'pending-private'), err => err.status === 403);
  let returned = false;
  const second = ensureGithubMirror('collaborator', 'org', 'pending-private').then(dir => { returned = true; return dir; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false);
  finishClone();
  const dirs = await Promise.all([first, second]);
  assert.equal(dirs[0], dirs[1]);
  assert.equal(clones, 1);
  assert.deepEqual(authTokens, ['owner-token', 'outsider-token', 'collaborator-token']);
});
