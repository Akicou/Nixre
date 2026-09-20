// The post-receive hook is what turns a push into webhooks and auto-deploy.
// It used to call curl unconditionally, discard its output and end in `|| true`
// — and nixre-core has no curl, so every HTTPS push failed silently and
// auto_deploy looked broken to anyone not pushing over SSH.
//
// These run the generated hook under /bin/sh with a PATH holding only the fake
// clients being tested, so "which HTTP client is installed" is the variable.

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installPostReceiveHook } from '../git/repo.js';

const exec = promisify(execFile);
const shellAvailable = process.platform !== 'win32';

/** A stub that records its argv, so we can prove which client the hook used. */
async function fakeClient(dir, name, { exitCode = 0 } = {}) {
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\necho "$@" >> "${dir}/calls.txt"\nexit ${exitCode}\n`, 'utf8');
  await chmod(file, 0o755);
}

// Drive the hook through a wrapper that feeds one ref update on stdin the way
// git does. Running it with stdin left open makes `while read` block forever.
async function pushRef({ clients, exitCode = 0, ref = 'refs/heads/main' }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nixre-hook-'));
  const repo = path.join(dir, 'repos', 'acme', 'mono.git');
  const bin = path.join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(repo, { recursive: true });
  await installPostReceiveHook(repo);
  for (const name of clients) await fakeClient(bin, name, { exitCode });

  const driver = path.join(dir, 'drive.sh');
  await writeFile(
    driver,
    `#!/bin/sh\ncd "${repo}"\nprintf '%s %s %s\\n' aaa bbb ${ref} | sh "${repo}/hooks/post-receive"\n`,
    'utf8',
  );
  await chmod(driver, 0o755);

  const result = await exec('/bin/sh', [driver], {
    env: { PATH: `${bin}:/bin:/usr/bin`, INTERNAL_TOKEN: 'test-token', CORE_URL: 'http://core:3002' },
  }).catch(err => ({ stdout: err.stdout || '', stderr: err.stderr || '', failed: true }));

  const calls = await readFile(path.join(bin, 'calls.txt'), 'utf8').catch(() => '');
  return { ...result, calls };
}

test('the hook notifies core with curl when curl is installed', { skip: !shellAvailable }, async () => {
  const { calls, stderr } = await pushRef({ clients: ['curl'] });
  assert.match(calls, /push-event/, 'curl was called');
  assert.match(calls, /acme/, 'the space is in the payload');
  assert.match(calls, /refs|main/, 'the branch is in the payload');
  assert.equal(stderr.trim(), '', 'a working notification is silent');
});

// nixre-core ships busybox wget and no curl. This is the case that was broken.
test('the hook falls back to wget when curl is missing', { skip: !shellAvailable }, async () => {
  const { calls, stderr } = await pushRef({ clients: ['wget'] });
  assert.match(calls, /push-event/, 'wget carried the notification');
  assert.match(calls, /--post-data/, 'sent as a POST');
  assert.match(calls, /Authorization: Bearer test-token/, 'authenticated');
  assert.equal(stderr.trim(), '', 'a working notification is silent');
});

test('a failed notification is reported instead of swallowed', { skip: !shellAvailable }, async () => {
  const { stderr } = await pushRef({ clients: ['curl'], exitCode: 1 });
  assert.match(stderr, /could not notify core/, 'the pusher is told auto-deploy did not run');
});

test('no HTTP client at all still exits 0, so the push is never rejected', { skip: !shellAvailable }, async () => {
  const { stderr, failed } = await pushRef({ clients: [] });
  assert.ok(!failed, 'the hook exits 0');
  assert.match(stderr, /could not notify core/, 'but says so');
});

test('the hook ignores tag pushes', { skip: !shellAvailable }, async () => {
  const { calls, stderr } = await pushRef({ clients: ['curl'], ref: 'refs/tags/v1.0.0' });
  assert.equal(calls, '', 'a tag is not a branch update and notifies nothing');
  assert.equal(stderr.trim(), '', 'and is not reported as a failure');
});
