import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('updater Git prefix updates safely without discarding local work', async t => {
  const candidates = ['bash'];
  if (process.platform === 'win32') {
    const found = spawnSync('where.exe', ['git.exe'], { encoding: 'utf8' });
    for (const gitPath of (found.stdout || '').trim().split(/\r?\n/).filter(Boolean)) {
      candidates.unshift(path.resolve(path.dirname(gitPath), '../bin/bash.exe'));
    }
  }
  const bash = candidates.find(candidate =>
    spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 }).status === 0);
  if (!bash) {
    t.skip('Bash unavailable (install Git Bash on Windows)');
    return;
  }

  const source = readFileSync(new URL('../../../update-nixre.sh', import.meta.url), 'utf8');
  const marker = '\nlog "Checking Compose configuration';
  const end = source.indexOf(marker);
  assert.ok(end > 0, 'production prefix must stop at the Compose-validation marker');
  assert.equal(source.indexOf(marker, end + 1), -1, 'extraction marker must be unique');
  const prefix = source.slice(0, end);
  // Execute real updater logic, but never include build, deployment, or health probes.
  assert.doesNotMatch(prefix.replace(/^\s*#.*$/gm, ''), /\b(?:npm|docker|curl)\b/);
  assert.match(source.slice(end), /\ndocker compose config --quiet/);
  assert.match(prefix, /NIXRE_DIR="\$\{NIXRE_DIR:-\/opt\/nixre\}"/);

  const root = mkdtempSync(path.join(tmpdir(), 'nixre-updater-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  // Avoid host NVM startup, Git hooks/signing settings, and inherited repository overrides.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^GIT_/i.test(key) && !/^(?:HOME|BASH_ENV|ENV)$/i.test(key)));
  Object.assign(env, {
    HOME: root.replaceAll('\\', '/'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'absent-gitconfig'),
    GIT_AUTHOR_NAME: 'Updater Test',
    GIT_AUTHOR_EMAIL: 'updater@example.invalid',
    GIT_COMMITTER_NAME: 'Updater Test',
    GIT_COMMITTER_EMAIL: 'updater@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
  });
  function run(command, args, cwd = root) {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  }
  const git = (cwd, ...args) => run('git', args, cwd);
  const syntax = spawnSync(bash, ['-n'], { input: source, env, encoding: 'utf8', timeout: 5000 });
  assert.equal(syntax.status, 0, syntax.stderr);

  const origin = path.join(root, 'origin.git');
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  function clone(name) {
    git(root, 'clone', origin, name);
    return path.join(root, name);
  }
  function commit(cwd, filename, content) {
    writeFileSync(path.join(cwd, filename), content);
    git(cwd, 'add', filename);
    git(cwd, 'commit', '-m', `test: ${filename}`);
    return git(cwd, 'rev-parse', 'HEAD');
  }
  function snapshot(cwd) {
    const files = git(cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
      .split('\0').filter(Boolean);
    return {
      head: git(cwd, 'rev-parse', 'HEAD'),
      status: git(cwd, 'status', '--porcelain'),
      index: git(cwd, 'ls-files', '--stage'),
      files: Object.fromEntries(files.map(file => [file, readFileSync(path.join(cwd, file))])),
    };
  }
  function check(cwd, status, message, target) {
    const before = snapshot(cwd);
    const result = spawnSync(bash, ['-s'], {
      cwd: root,
      env: { ...env, NIXRE_DIR: cwd.replaceAll('\\', '/') },
      input: prefix,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, status, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, message);
    if (target) {
      assert.equal(git(cwd, 'rev-parse', 'HEAD'), target);
      git(cwd, 'merge-base', '--is-ancestor', before.head, target);
      assert.equal(git(cwd, 'status', '--porcelain'), '');
      assert.equal(readFileSync(path.join(cwd, 'remote.txt'), 'utf8').replaceAll('\r\n', '\n'), 'remote\n');
    } else {
      assert.deepEqual(snapshot(cwd), before, 'HEAD, index, and all working files must be preserved');
    }
  }

  const writer = clone('writer');
  commit(writer, 'base.txt', 'base\n');
  git(writer, 'push', 'origin', 'main');
  await t.test('up-to-date checkout is unchanged', () => {
    check(clone('equal'), 0, /Already up to date/);
  });
  await t.test('behind checkout fast-forwards', () => {
    const cwd = clone('behind');
    const target = commit(writer, 'remote.txt', 'remote\n');
    git(writer, 'push', 'origin', 'main');
    check(cwd, 0, /Fast-forwarded/, target);
  });
  await t.test('ahead checkout keeps unpublished commits', () => {
    const cwd = clone('ahead');
    commit(cwd, 'local.txt', 'local\n');
    check(cwd, 0, /keeping local commits/);
  });
  await t.test('divergence fails without losing local commits', () => {
    const cwd = clone('diverged');
    commit(cwd, 'unpublished.txt', 'unpublished\n');
    commit(writer, 'new-remote.txt', 'new remote\n');
    git(writer, 'push', 'origin', 'main');
    check(cwd, 1, /refusing to reset/);
  });
  for (const type of ['unstaged', 'staged', 'untracked']) {
    await t.test(`${type} changes are rejected and preserved`, () => {
      const cwd = clone(type);
      const file = type === 'untracked' ? 'untracked.txt' : 'base.txt';
      writeFileSync(path.join(cwd, file), 'preserve this work\n');
      if (type === 'staged') git(cwd, 'add', file);
      check(cwd, 1, /uncommitted changes/);
    });
  }
  await t.test('missing remote branch preserves the current checkout', () => {
    const cwd = clone('local-only');
    git(cwd, 'switch', '-c', 'local-only');
    check(cwd, 0, /no origin\/local-only/);
  });
});
