import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

async function fixture(fn) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nixre-control-'));
  const root = path.join(temp, 'repo'), store = path.join(temp, 'checkpoints');
  await fs.mkdir(root);
  execFileSync('git', ['init', '-q', root]);
  const source = (await fs.readFile(new URL('./agentWorkspace.py', import.meta.url), 'utf8'))
    .replace("pathlib.Path('/workspace/repo')", `pathlib.Path(${JSON.stringify(root)})`)
    .replace("pathlib.Path('/workspace/.nixre-checkpoints')", `pathlib.Path(${JSON.stringify(store)})`);
  const operation = input => JSON.parse(execFileSync('python3', ['-c', source], { input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
  try { await fn(root, operation); } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
test('checkpoint restore preserves uncommitted files, binary bytes and executable permissions', async () => fixture(async (root, op) => {
  await fs.writeFile(path.join(root, 'a.txt'), 'before');
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 255]));
  await fs.chmod(path.join(root, 'a.txt'), 0o755);
  const cp = op({ op: 'checkpoint' });
  await fs.writeFile(path.join(root, 'a.txt'), 'after');
  await fs.writeFile(path.join(root, 'new.txt'), 'new');
  const result = op({ op: 'restore', id: cp.id });
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'before');
  assert.deepEqual(await fs.readFile(path.join(root, 'binary')), Buffer.from([0, 1, 255]));
  assert.equal((await fs.stat(path.join(root, 'a.txt'))).mode & 0o777, 0o755);
  await assert.rejects(fs.access(path.join(root, 'new.txt')));
  assert.ok(result.checkpoint.id);
}));
test('review checks current content and rejects stale edits and symlink traversal', async () => fixture(async (root, op) => {
  await fs.writeFile(path.join(root, 'a.txt'), 'before');
  assert.throws(() => op({ op: 'apply', path: 'a.txt', before: 'old', content: 'bad' }));
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'before');
  await fs.symlink('/tmp', path.join(root, 'link'));
  assert.throws(() => op({ op: 'read', path: 'link/anything' }));
  assert.throws(() => op({ op: 'read', path: '../anything' }));
  assert.throws(() => op({ op: 'read', path: '.git/config' }));
}));
test('verification discovers scripts and records failing exit status', async () => fixture(async (root, op) => {
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(3)"', build: 'node -e "console.log(123)"' } }));
  const result = op({ op: 'verify' });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].exitCode, 3);
  assert.equal(result.results[1].exitCode, 0);
  assert.match(result.results[1].output, /123/);
}));
test('review returns a unified diff and accepting an edit creates an undo checkpoint', async () => fixture(async (root, op) => {
  await fs.writeFile(path.join(root, 'a.txt'), 'old\n');
  const review = op({ op: 'read', path: 'a.txt', proposed: 'new\n' });
  assert.match(review.patch, /-old\n\+new/);
  const apply = op({ op: 'apply', path: 'a.txt', before: 'old\n', content: 'new\n' });
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'new\n');
  op({ op: 'restore', id: apply.checkpoint.id });
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'old\n');
}));
test('live inspections include newly accepted files and omit deleted workspace files', async () => fixture(async (root, op) => {
  await fs.writeFile(path.join(root, 'new.js'), 'const live = 1;\n');
  assert.ok(op({ op: 'list' }).files.includes('new.js'));
  assert.match(op({ op: 'search', query: 'live' }).matches[0], /new.js:1:/);
  await fs.unlink(path.join(root, 'new.js'));
  assert.equal(op({ op: 'read', path: 'new.js' }).content, null);
}));
