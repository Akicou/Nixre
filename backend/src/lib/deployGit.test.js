import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter, once } from 'node:events';
import { spawn as spawnProcess } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { externalGitHosts, validateExternalGitUrl, prepareExternalSource } from './deployGit.js';

const URL = 'https://github.com/ggml-org/llama.cpp.git';
const SHA = 'a'.repeat(40);
const SOURCE = { gitUrl: URL, ref: 'refs/pull/123/head' };

function commandArgs(args) {
  let i = 0;
  while (args[i] === '-c') i += 2;
  return args.slice(i);
}

async function fixture(t, handlers = {}, options = {}) {
  const root = await mkdtemp(path.join(process.env.NIXRE_TEST_TMPDIR || tmpdir(), 'deploy-git-test-'));
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  const calls = [];
  const leases = [];
  t.after(async () => {
    await Promise.all(leases.map(lease => lease.cleanup()));
    await rm(root, { recursive: true, force: true });
  });
  const spawn = (command, args, opts) => {
    const cmd = commandArgs(args);
    calls.push({ command, args, cmd, opts });
    if (options.real && cmd[0] !== 'fetch') return spawnProcess(command, args, opts);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = 0;
    let closed = false;
    const finish = ({ stdout = '', stderr = '', code = 0 } = {}) => {
      if (closed) return;
      closed = true;
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setImmediate(() => child.emit('close', code));
    };
    child.kill = () => { child.kills++; finish({ code: null }); return true; };
    calls.at(-1).child = child;
    setImmediate(async () => {
      try {
        if (handlers[cmd[0]]) {
          const result = await handlers[cmd[0]]({ cmd, args, opts, child, finish });
          if (result === false) return;
          finish(result);
          return;
        }
        const results = {
          '--version': 'git version 2.50.0\n', init: '', fetch: '',
          'rev-parse': `${SHA}\n`, 'cat-file': 'tree\n',
          'ls-tree': `100644 blob ${SHA}\t${cmd.at(-1)}\0`,
          log: 'Custom CPU branch\n', archive: 'fake tar bytes',
        };
        assert.ok(Object.hasOwn(results, cmd[0]), `Unexpected Git command: ${cmd[0]}`);
        finish({ stdout: results[cmd[0]] });
      } catch (error) { child.emit('error', error); finish({ code: 1 }); }
    });
    return child;
  };
  const io = { spawn, env: {}, tempRoot: root, ...options };
  return {
    root, calls, io,
    async prepare(input = {}, overrides = {}) {
      const lease = await prepareExternalSource({ ...SOURCE, ...input }, { ...io, ...overrides });
      leases.push(lease);
      return lease;
    },
  };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail('Condition did not become true');
}

test('URL validation is synchronous and canonical; host extensions are exact and pure', t => {
  t.mock.method(dns, 'lookup', () => assert.fail('Pure URL validation must not resolve DNS'));
  assert.equal(validateExternalGitUrl('HTTPS://GitHub.COM:443/ggml-org/llama.cpp.git/', {}), URL);
  assert.deepEqual(externalGitHosts({}), ['github.com']);
  const env = { NIXRE_DEPLOY_GIT_HOSTS: ' GitLab.COM, code.example.org,github.com,gitlab.com, ' };
  assert.deepEqual(externalGitHosts(env), ['github.com', 'gitlab.com', 'code.example.org']);
  assert.equal(validateExternalGitUrl('https://gitlab.com/group/subgroup/llama.cpp', env), 'https://gitlab.com/group/subgroup/llama.cpp');
  assert.throws(() => validateExternalGitUrl('https://sub.gitlab.com/a/b', env), { status: 400 });
  for (const host of ['*.example.com', 'https://example.com', 'example.com:443', 'example.com.', '127.0.0.1', '[::1]', 'localhost', 'foo..com']) {
    assert.throws(() => externalGitHosts({ NIXRE_DEPLOY_GIT_HOSTS: host }), { status: 400 }, host);
  }
});

test('hostile URLs cannot use parser normalization, credentials, other ports or protocols', () => {
  for (const value of [undefined, null, {}, '', 'git@github.com:a/b', 'file:///etc/passwd',
    'http://github.com/a/b', 'ssh://github.com/a/b', 'ext::id', 'https:github.com/a/b',
    'https:///github.com/a/b', 'https://github.com', 'https://github.com/',
    'https://evil.example/a/b', 'https://github.com.evil.example/a/b',
    'https://user:pass@github.com/a/b', 'https://@github.com/a/b',
    'https://github.com:80/a/b', 'https://github.com:444/a/b', 'https://github.com:/a/b',
    'https://github.com/a/b?', 'https://github.com/a/b#', 'https://github.com/a/b?token=secret',
    ' https://github.com/a/b', 'https://github.com/a/b\n', 'https://git\thub.com/a/b',
    'https://github.com/a/\0b', 'https://github.com/a/\x7fb', 'https://github.com/a/%0ab',
    'https://%67ithub.com/a/b', 'https://github.com/a/%2e%2e/b', 'https://github.com/a/%252e/b',
    'https://github.com/a/../b', 'https://github.com/a/./b', 'https://github.com/a//b',
    'https://github.com\\@evil.example/a/b', 'https://github.com/a\\b',
    'https://github.com./a/b', 'https://127.0.0.1/a/b', 'https://[::1]/a/b',
    `https://github.com/${'a'.repeat(2048)}`]) {
    assert.throws(() => validateExternalGitUrl(value, {}), error => error instanceof Error && error.status === 400, String(value));
  }
});

test('unsafe refs and paths fail before DNS, processes or temporary directories', async t => {
  const f = await fixture(t);
  t.mock.method(dns, 'lookup', () => assert.fail('Invalid input must fail before DNS'));
  for (const ref of ['', null, {}, '-main', '--upload-pack=id', '+main', 'main:refs/heads/x',
    '^main', '*', 'refs/heads/*', 'main~1', 'main^{}', 'main@{1}', 'main..other',
    'main\n', 'main\t', 'main branch', 'refs/replace/abc', 'refs/remotes/origin/main',
    'refs/pull/123/merge', 'refs/pull/0/head', 'refs/heads/', 'x/.hidden', 'x.lock',
    'x//y', 'x/-y', 'x.', 'x/', 'x\\y', 'a'.repeat(401)]) {
    await assert.rejects(f.prepare({ ref }), { status: 400 }, String(ref));
  }
  for (const field of ['rootDir', 'dockerfilePath']) {
    for (const value of ['', null, {}, '/tmp', '../Dockerfile', 'a/../../Dockerfile', 'a/./Dockerfile',
      'a//Dockerfile', '--output=owned', 'a/-option', 'C:/Windows', 'C:\\Windows',
      '\\\\server\\share', 'a:b', ':(glob)*', 'Dockerfile*', 'Dockerfile?', 'a[0]',
      'a\0b', 'a\rb', 'a\nb', ' a', 'a ', '.git/config', 'a/.GIT/config']) {
      await assert.rejects(f.prepare({ [field]: value }), { status: 400 }, `${field}: ${String(value)}`);
    }
  }
  await assert.rejects(f.prepare({ dockerfilePath: '.' }), { status: 400 });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.root), []);
});

test('branches, explicit tags, PR heads and commit IDs fetch a single safe source ref', async t => {
  const f = await fixture(t);
  for (const ref of ['HEAD', 'custom/llama-cpu', 'b1234', 'refs/heads/custom/cpu', 'refs/tags/v1.2.3', 'refs/pull/123/head', SHA]) {
    const source = await f.prepare({ ref });
    const cmd = f.calls.filter(call => call.cmd[0] === 'fetch').at(-1).cmd;
    assert.deepEqual(cmd, ['fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', '--quiet', '--', URL,
      ref === 'HEAD' || ref.startsWith('refs/') || ref === SHA ? ref : `refs/heads/${ref}`]);
    await source.cleanup();
  }
  assert.deepEqual(await readdir(f.root), []);
});

test('all Git subprocesses use pinned HTTPS, no redirects and an isolated safe environment', async t => {
  const poison = {
    PATH: process.env.PATH || process.env.Path,
    SystemRoot: process.env.SystemRoot || 'C:\\Windows',
    HOME: '/secret/home', XDG_CONFIG_HOME: '/secret/config', USERPROFILE: '/secret/profile',
    GITHUB_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'secret', NIXRE_INTERNAL_TOKEN: 'secret',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.proxy', GIT_CONFIG_VALUE_0: 'http://localhost',
    GIT_CONFIG_PARAMETERS: 'poison', GIT_CONFIG_GLOBAL: '/secret/gitconfig',
    GIT_CONFIG_SYSTEM: '/secret/system', GIT_DIR: '/forge/repo', GIT_WORK_TREE: '/forge/work',
    GIT_OBJECT_DIRECTORY: '/forge/objects', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/forge/objects',
    GIT_EXEC_PATH: '/malicious/bin', GIT_SSH_COMMAND: 'id', GIT_ASKPASS: 'steal',
    GIT_SSL_NO_VERIFY: '1', GIT_SSL_CERT: '/secret/cert', SSLKEYLOGFILE: '/secret/log',
    HTTPS_PROXY: 'http://localhost', http_proxy: 'http://localhost', ALL_PROXY: 'socks5://localhost',
    LD_PRELOAD: '/malicious/library', NODE_OPTIONS: '--require=/malicious/code',
    CURL_HOME: '/secret/curl', NETRC: '/secret/netrc', KRB5CCNAME: '/secret/kerberos',
  };
  const f = await fixture(t, {}, { env: poison });
  let lookups = 0;
  t.mock.method(dns, 'lookup', async (host, opts) => {
    assert.equal(host, 'github.com');
    assert.equal(opts.all, true);
    lookups++;
    return [{ address: '2606:4700:4700::1111', family: 6 }, { address: '8.8.8.8', family: 4 }];
  });
  const source = await f.prepare({ rootDir: './docker', dockerfilePath: './cpu.Dockerfile' });
  assert.equal(source.sha, SHA);
  assert.equal(source.message, 'Custom CPU branch');
  assert.equal((await collect(await source.archive())).toString(), 'fake tar bytes');
  assert.equal(lookups, 1);
  for (const { command, args, opts } of f.calls) {
    assert.equal(command, 'git');
    assert.equal(opts.shell, false);
    assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
    assert.ok(opts.cwd.startsWith(f.root + path.sep));
    for (const config of ['http.curloptResolve=github.com:443:8.8.8.8', 'http.followRedirects=false',
      'http.proxy=', 'http.sslVerify=true', 'http.emptyAuth=false', 'credential.helper=',
      'protocol.allow=never', 'protocol.https.allow=always', 'protocol.file.allow=never',
      'protocol.ext.allow=never', 'protocol.ssh.allow=never', 'submodule.recurse=false',
      'fetch.recurseSubmodules=false', 'fetch.fsckObjects=true', 'fetch.uriprotocols=', 'gc.auto=0']) {
      assert.ok(args.includes(config), config);
    }
    assert.equal(opts.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(opts.env.GIT_CONFIG_GLOBAL, path.join(opts.env.HOME, 'empty-config'));
    assert.equal(opts.env.GIT_CONFIG_SYSTEM, opts.env.GIT_CONFIG_GLOBAL);
    assert.equal(await readFile(opts.env.GIT_CONFIG_GLOBAL, 'utf8'), '');
    assert.equal(opts.env.GIT_ALLOW_PROTOCOL, 'https');
    assert.equal(opts.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(opts.env.GIT_LFS_SKIP_SMUDGE, '1');
    assert.ok(opts.env.HOME.startsWith(f.root + path.sep));
    assert.equal(opts.env.PATH, poison.PATH);
    for (const key of Object.keys(poison)) {
      if (!['PATH', 'SystemRoot', 'HOME', 'XDG_CONFIG_HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'].includes(key)) {
        assert.equal(opts.env[key], undefined, `${key} must not be inherited`);
      }
    }
  }
  const init = f.calls.find(call => call.cmd[0] === 'init');
  assert.equal(init.cmd[1], '--bare');
  const template = init.cmd[2].slice('--template='.length);
  assert.deepEqual(await readdir(template), []);
  assert.ok(init.args.includes(`core.hooksPath=${template}`));
  assert.equal(await readFile(path.join(init.opts.cwd, 'info', 'attributes'), 'utf8'), '* -export-ignore -export-subst\n');
  assert.deepEqual(f.calls.find(call => call.cmd[0] === 'rev-parse').cmd, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
  assert.deepEqual(f.calls.find(call => call.cmd[0] === 'ls-tree').cmd, ['ls-tree', '-z', '--full-tree', `${SHA}:docker`, '--', 'cpu.Dockerfile']);
  assert.deepEqual(f.calls.find(call => call.cmd[0] === 'archive').cmd, ['archive', '--format=tar', `${SHA}:docker`]);
  await source.cleanup();
  await source.cleanup();
  assert.deepEqual(await readdir(f.root), []);
  await assert.rejects(source.archive(), /cleaned up/);
});

test('IPv6-only public results are bracketed in curloptResolve', async t => {
  const f = await fixture(t);
  t.mock.method(dns, 'lookup', async () => [{ address: '2606:4700:4700::1111', family: 6 }]);
  const source = await f.prepare();
  assert.ok(f.calls.find(call => call.cmd[0] === 'fetch').args.includes('http.curloptResolve=github.com:443:[2606:4700:4700::1111]'));
  await source.cleanup();
});

test('private, mixed, malformed and failed DNS results never start Git', async t => {
  const f = await fixture(t);
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '::ffff:127.0.0.1', family: 6 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 6 }], [{ address: '8.8.8.8,127.0.0.1', family: 4 }]]) {
    t.mock.method(dns, 'lookup', async () => addresses);
    await assert.rejects(f.prepare(), { status: 400 });
  }
  t.mock.method(dns, 'lookup', async () => { throw Object.assign(new Error('DNS unavailable'), { code: 'EAI_AGAIN' }); });
  await assert.rejects(f.prepare(), /Could not resolve/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.root), []);
});

test('unsupported Git versions fail closed before init or fetch', async t => {
  const f = await fixture(t, { '--version': () => ({ stdout: 'git version 2.36.9\n' }) });
  await assert.rejects(f.prepare(), /Git 2.37 or newer.*curloptResolve/);
  assert.deepEqual(f.calls.map(call => call.cmd[0]), ['--version']);
  assert.deepEqual(await readdir(f.root), []);
});

test('only a regular Dockerfile at the immutable context tree is accepted', async t => {
  let mode = '100755', type = 'blob', name = 'recipes/Build.cpu';
  const f = await fixture(t, { 'ls-tree': () => ({ stdout: mode ? `${mode} ${type} ${SHA}\t${name}\0` : '' }) });
  const source = await f.prepare({ rootDir: 'nested/context', dockerfilePath: name });
  await source.cleanup();
  for (const [nextMode, nextType] of [['120000', 'blob'], ['040000', 'tree'], ['160000', 'commit'], ['', '']]) {
    mode = nextMode; type = nextType;
    await assert.rejects(f.prepare({ dockerfilePath: name }), error => error.status === 400 && /regular file/.test(error.message));
  }
  mode = '100644'; type = 'blob'; name = 'Dockerfile.evil';
  await assert.rejects(f.prepare(), /regular file/);
  assert.deepEqual(await readdir(f.root), []);
});

test('non-directory contexts and malformed resolved SHAs are rejected and cleaned', async t => {
  let sha = SHA;
  const f = await fixture(t, { 'rev-parse': () => ({ stdout: sha }), 'cat-file': () => ({ stdout: 'blob\n' }) });
  await assert.rejects(f.prepare({ rootDir: 'linked-context' }), /existing directory/);
  sha = '--output=/tmp/owned';
  await assert.rejects(f.prepare(), /invalid commit SHA/);
  assert.deepEqual(await readdir(f.root), []);
});

test('failed fetches and bounded stdout/stderr are cleaned without accepting partial output', async t => {
  let result = { code: 128, stderr: 'HTTP 302 redirect refused' };
  const f = await fixture(t, { fetch: () => result });
  await assert.rejects(f.prepare(), /git fetch failed.*HTTP 302 redirect refused/);
  for (const channel of ['stdout', 'stderr']) {
    result = { [channel]: Buffer.alloc(65 * 1024, 120) };
    await assert.rejects(f.prepare(), new RegExp(`${channel} exceeds`));
    assert.deepEqual(await readdir(f.root), []);
  }
});

test('synchronous and asynchronous spawn errors clean their owned temporary directories', async t => {
  const f = await fixture(t);
  await assert.rejects(f.prepare({}, { spawn: () => { throw new Error('spawn failed'); } }), /spawn failed/);
  const g = await fixture(t, { '--version': ({ child }) => { child.emit('error', new Error('ENOENT git')); return { code: -2 }; } });
  await assert.rejects(g.prepare(), /ENOENT git/);
  assert.deepEqual(await readdir(f.root), []);
  assert.deepEqual(await readdir(g.root), []);
});

test('cancellation before acquisition, during DNS and during fetch cleans up', async t => {
  const f = await fixture(t, { fetch: () => false });
  await assert.rejects(f.prepare({ signal: AbortSignal.abort(new Error('already cancelled')) }), /already cancelled/);
  const dnsController = new AbortController();
  t.mock.method(dns, 'lookup', () => new Promise(() => {}));
  const resolving = f.prepare({ signal: dnsController.signal });
  const dnsRejected = assert.rejects(resolving, /cancel DNS/);
  dnsController.abort(new Error('cancel DNS'));
  await dnsRejected;
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  const fetchController = new AbortController();
  const fetching = f.prepare({ signal: fetchController.signal });
  const fetchRejected = assert.rejects(fetching, /cancel fetch/);
  await until(() => f.calls.some(call => call.cmd[0] === 'fetch'));
  fetchController.abort(new Error('cancel fetch'));
  await fetchRejected;
  assert.ok(f.calls.find(call => call.cmd[0] === 'fetch').child.kills > 0);
  assert.deepEqual(await readdir(f.root), []);
});

test('deadline covers slow DNS and fetch, not just process startup', async t => {
  const f = await fixture(t, { fetch: () => false }, { timeoutMs: 50 });
  t.mock.method(dns, 'lookup', () => new Promise(() => {}));
  // The production deadline is unref'ed; keep this hermetic DNS promise's test alive.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(f.prepare(), { name: 'TimeoutError' });
    t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
    await assert.rejects(f.prepare(), { name: 'TimeoutError' });
    assert.deepEqual(await readdir(f.root), []);
  } finally { clearInterval(keepAlive); }
});

test('temporary pack growth stops acquisition and preserves unrelated files', async t => {
  const f = await fixture(t, {
    fetch: async ({ opts }) => {
      await mkdir(path.join(opts.cwd, 'objects', 'pack'), { recursive: true });
      await writeFile(path.join(opts.cwd, 'objects', 'pack', 'tmp_pack'), Buffer.alloc(4096));
      return false;
    },
  }, { maxBytes: 1024, monitorIntervalMs: 5 });
  await writeFile(path.join(f.root, 'user-owned.txt'), 'do not delete');
  const keepAlive = setInterval(() => {}, 100);
  try { await assert.rejects(f.prepare(), /temporary files exceed/); }
  finally { clearInterval(keepAlive); }
  assert.deepEqual(await readdir(f.root), ['user-owned.txt']);
  assert.equal(await readFile(path.join(f.root, 'user-owned.txt'), 'utf8'), 'do not delete');
});

test('at most two live leases; cleanup is idempotent and makes capacity available', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.prepare(), f.prepare()]);
  await assert.rejects(f.prepare(), { status: 429 });
  await Promise.all([first.cleanup(), first.cleanup(), first.cleanup()]);
  const third = await f.prepare();
  await assert.rejects(f.prepare(), { status: 429 });
  await Promise.all([second.cleanup(), third.cleanup()]);
  assert.deepEqual(await readdir(f.root), []);
});

test('archive errors after stdout EOF reach the consumer, rather than a successful end', async t => {
  const f = await fixture(t, { archive: () => ({ stdout: 'partial tar', stderr: 'archive failed', code: 128 }) });
  const source = await f.prepare();
  await assert.rejects(collect(await source.archive()), /git archive failed.*archive failed/);
  await source.cleanup();
  assert.deepEqual(await readdir(f.root), []);
});

test('archive byte limit and deadline destroy the stream and clean up', async t => {
  let oversized = true;
  const f = await fixture(t, { archive: () => oversized ? { stdout: Buffer.alloc(2048) } : false }, { maxBytes: 1024 });
  const first = await f.prepare();
  await assert.rejects(collect(await first.archive()), /archive exceeds/);
  await first.cleanup();
  oversized = false;
  const second = await f.prepare({}, { timeoutMs: 100 });
  const keepAlive = setInterval(() => {}, 100);
  try { await assert.rejects(collect(await second.archive()), { name: 'TimeoutError' }); }
  finally { clearInterval(keepAlive); }
  await second.cleanup();
  assert.deepEqual(await readdir(f.root), []);
});

test('abort, explicit cleanup and early consumer close tear down archive processes', async t => {
  const f = await fixture(t, { archive: () => false });
  for (const action of ['abort', 'cleanup', 'consumer']) {
    const controller = new AbortController();
    const source = await f.prepare({ signal: controller.signal });
    const stream = await source.archive();
    await assert.rejects(source.archive(), /only be consumed once/);
    const closed = once(stream, 'close').catch(() => {});
    if (action === 'abort') controller.abort(new Error('cancel streaming'));
    if (action === 'cleanup') await source.cleanup();
    if (action === 'consumer') stream.destroy();
    await closed;
    await until(async () => (await readdir(f.root)).length === 0);
    await source.cleanup();
    assert.ok(f.calls.filter(call => call.cmd[0] === 'archive').at(-1).child.kills > 0);
  }
});

test('aborting an idle prepared source removes it even before archive is requested', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const source = await f.prepare({ signal: controller.signal });
  controller.abort(new Error('cancel idle source'));
  await until(async () => (await readdir(f.root)).length === 0);
  await source.cleanup();
  await assert.rejects(source.archive(), /cancel idle source/);
});

test('cancellation still destroys buffered archive data after Git has exited', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const source = await f.prepare({ signal: controller.signal });
  const stream = await source.archive();
  const archive = f.calls.find(call => call.cmd[0] === 'archive');
  await once(archive.child, 'close');
  assert.equal(stream.readableEnded, false);
  controller.abort(new Error('cancel buffered archive'));
  await assert.rejects(collect(stream), /cancel buffered archive/);
  await source.cleanup();
  assert.deepEqual(await readdir(f.root), []);
});

test('archive cancellation terminates a real subprocess and its pipe-holding descendant', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const source = await f.prepare({ signal: controller.signal }, {
    spawn(command, args, opts) {
      if (command !== 'git') return spawnProcess(command, args, opts); // Windows taskkill.
      if (commandArgs(args)[0] !== 'archive') return f.io.spawn(command, args, opts);
      return spawnProcess(process.execPath, ['-e',
        "const {spawn}=require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'}); process.stdout.write('ready'); setInterval(()=>{},1000);",
      ], opts);
    },
  });
  const stream = await source.archive();
  await once(stream, 'data');
  controller.abort(new Error('cancel process tree'));
  await source.cleanup();
  assert.equal(stream.destroyed, true);
  assert.deepEqual(await readdir(f.root), []);
});

// Real Git object/tree/archive coverage without any network transport. Only fetch
// is replaced: fast-import creates synthetic objects in the helper's private repo.
async function localGit(args, opts, input = '') {
  const child = spawnProcess('git', args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const closed = once(child, 'close');
  child.stdin.end(input);
  const [code] = await closed;
  assert.equal(code, 0, (await stderr).toString());
  return (await stdout).toString();
}

function tarFiles(tar) {
  const result = new Map();
  for (let offset = 0; offset + 512 <= tar.length && tar[offset];) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8) || 0;
    result.set(name, tar.subarray(offset + 512, offset + 512 + size).toString());
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}

test('real Git verifies files at a commit and strips the chosen context without hooks, LFS or submodules', async t => {
  const files = [
    ['100644', 'context/cpu.Dockerfile', 'FROM scratch\n'],
    ['100755', 'context/recipes/custom-build', 'FROM scratch\n'],
    ['100644', 'context/.gitattributes', '* export-ignore export-subst filter=lfs\n'],
    ['100644', 'context/model.bin', 'version https://git-lfs.github.com/spec/v1\noid sha256:123\nsize 999999\n'],
    ['100644', 'context/.gitmodules', '[submodule "private"]\npath = private\nurl = file:///secret\n'],
    ['100644', 'outside.txt', 'not in the build context'],
    ['120000', 'context/linked.Dockerfile', 'cpu.Dockerfile'],
    ['120000', 'linked-context', 'context'],
  ];
  let fastImport = '';
  files.forEach(([, , content], index) => { fastImport += `blob\nmark :${index + 1}\ndata ${Buffer.byteLength(content)}\n${content}\n`; });
  fastImport += 'commit refs/heads/fixture\ncommitter Fixture <fixture@example.invalid> 1000000000 +0000\ndata 14\nFixture commit\n';
  files.forEach(([mode, name], index) => { fastImport += `M ${mode} :${index + 1} ${name}\n`; });
  fastImport += `M 160000 ${SHA} context/private\n\ndone\n`;
  const f = await fixture(t, {
    fetch: async ({ args, opts }) => {
      const configs = args.slice(0, args.indexOf('fetch'));
      await localGit([...configs, 'fast-import', '--quiet'], opts, fastImport);
      const sha = (await localGit([...configs, 'rev-parse', 'refs/heads/fixture'], opts)).trim();
      await writeFile(path.join(opts.cwd, 'FETCH_HEAD'), `${sha}\t\tfixture\n`);
      return {};
    },
  }, { real: true, env: process.env });
  for (const dockerfilePath of ['cpu.Dockerfile', 'recipes/custom-build']) {
    const source = await f.prepare({ rootDir: 'context', dockerfilePath });
    assert.match(source.sha, /^[a-f0-9]{40}$/);
    assert.equal(source.message, 'Fixture commit');
    const entries = tarFiles(await collect(await source.archive()));
    assert.equal(entries.get(dockerfilePath), 'FROM scratch\n');
    assert.equal(entries.get('model.bin'), files[3][2]);
    assert.equal(entries.has('outside.txt'), false);
    assert.equal(entries.has('context/cpu.Dockerfile'), false);
    assert.equal(entries.has('private/secret'), false);
    await source.cleanup();
  }
  for (const input of [{ dockerfilePath: 'linked.Dockerfile' }, { dockerfilePath: 'recipes' },
    { dockerfilePath: 'private' }, { dockerfilePath: 'missing.Dockerfile' },
    { dockerfilePath: 'private/Dockerfile' }, { rootDir: 'linked-context' }, { rootDir: 'missing' }]) {
    await assert.rejects(f.prepare({ rootDir: 'context', ...input }));
  }
  assert.deepEqual(await readdir(f.root), []);
});
