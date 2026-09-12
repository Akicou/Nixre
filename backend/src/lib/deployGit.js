// Public external sources stay separate from the forge's repositories and credentials.
import { spawn as spawnProcess } from 'node:child_process';
import { mkdir, mkdtemp, opendir, lstat, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { assertPublicUrl, isPrivateAddress } from './netGuard.js';

const MAX_BYTES = 1024 ** 3;
const MAX_OUTPUT = 64 * 1024;
let activeSources = 0;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function externalGitHosts(env = process.env) {
  const hosts = new Set(['github.com']);
  for (const entry of String(env.NIXRE_DEPLOY_GIT_HOSTS || '').split(',')) {
    const host = entry.trim().toLowerCase();
    if (!host) continue;
    if (host.length > 253 || isIP(host) || !host.includes('.') ||
        !/[a-z]/.test(host.split('.').at(-1)) ||
        !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw invalid('NIXRE_DEPLOY_GIT_HOSTS must contain exact DNS hostnames, without URLs, ports or wildcards');
    }
    hosts.add(host);
  }
  return [...hosts];
}

export function validateExternalGitUrl(raw, env = process.env) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048 || /[^\x21-\x7e]/.test(raw)) {
    throw invalid('gitUrl must be an HTTPS repository URL without whitespace or control characters');
  }
  const parts = /^https:\/\/([a-z0-9.-]+)(?::443)?(\/[^?#]*)$/i.exec(raw);
  if (!parts || /[%\\]/.test(raw)) {
    throw invalid('gitUrl must use HTTPS on port 443, without credentials, query, fragment or URL escapes');
  }
  let url;
  try { url = new URL(raw); }
  catch { throw invalid('gitUrl is not a valid HTTPS repository URL'); }
  const hosts = externalGitHosts(env);
  if (url.hostname !== parts[1].toLowerCase() || !hosts.includes(url.hostname)) {
    throw invalid(`External Git host is not supported; allowed hosts: ${hosts.join(', ')}`);
  }
  const repoPath = parts[2].replace(/\/$/, '');
  if (!repoPath || !/^\/[a-z0-9._~/-]+$/i.test(repoPath) ||
      repoPath.slice(1).split('/').some(part => !part || part === '.' || part === '..')) {
    throw invalid('gitUrl must point to a repository, without empty or traversal path segments');
  }
  url.pathname = repoPath;
  return url.href;
}

function sourceRef(ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 400) throw invalid('ref must be a branch, refs/tags/name, refs/pull/123/head or full commit SHA');
  if (ref === 'HEAD' || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref)) return ref;
  if (/^refs\/pull\/[1-9][0-9]*\/head$/.test(ref)) return ref;
  let name = ref;
  if (ref.startsWith('refs/')) {
    if (!/^refs\/(heads|tags)\//.test(ref)) throw invalid('Only head, tag and pull-request head refs are supported');
    name = ref.replace(/^refs\/(heads|tags)\//, '');
  }
  if (!/^[a-z0-9_][a-z0-9._/-]*$/i.test(name) || name.includes('..') ||
      name.split('/').some(part => !part || part.startsWith('.') || part.startsWith('-') || part.endsWith('.') || /\.lock$/i.test(part))) {
    throw invalid('ref must be a literal branch or tag name, not options, revision expressions or refspecs');
  }
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
}

function sourcePath(raw, label, root = false) {
  if (typeof raw !== 'string' || !raw || raw.length > 1024 || raw !== raw.trim() || /[\x00-\x1f\x7f-\x9f\\:*?[\]{}^~]/.test(raw)) {
    throw invalid(`${label} must be a relative Git path without control characters or path expressions`);
  }
  const value = raw.startsWith('./') ? raw.slice(2) : raw;
  if (root && (value === '.' || value === '')) return '.';
  if (value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('-') || part.toLowerCase() === '.git')) {
    throw invalid(`${label} must stay inside the build root; absolute paths, traversal and options are not allowed`);
  }
  return value;
}

async function checkTempSize(dir, maxBytes, signal) {
  let bytes = 0;
  const pending = [dir];
  while (pending.length) {
    signal.throwIfAborted();
    const entries = await opendir(pending.pop());
    for await (const entry of entries) {
      signal.throwIfAborted();
      const file = path.join(entries.path, entry.name);
      let stat;
      try { stat = await lstat(file); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      // Never traverse links, even when accounting for temporary files.
      if (stat.isDirectory()) pending.push(file);
      else bytes += stat.size;
      if (bytes > maxBytes) throw new Error(`External Git temporary files exceed the ${maxBytes}-byte limit`);
    }
  }
}

/**
 * Acquire a public source, then stream its immutable build context. Always call
 * cleanup in the consumer's finally. The second argument is trusted test IO,
 * never deployment input. At most two source leases may be live per process.
 * Requires Git >= 2.37 (curloptResolve); bracketed IPv6 needs libcurl >= 7.57.
 */
export async function prepareExternalSource(
  { gitUrl, ref = 'HEAD', rootDir = '.', dockerfilePath = 'Dockerfile', signal: callerSignal },
  { spawn = spawnProcess, env = process.env, tempRoot = tmpdir(), timeoutMs = 120_000,
    maxBytes = MAX_BYTES, monitorIntervalMs = 250 } = {},
) {
  const url = validateExternalGitUrl(gitUrl, env);
  const safeRef = sourceRef(ref);
  const root = sourcePath(rootDir, 'rootDir', true);
  const dockerfile = sourcePath(dockerfilePath, 'dockerfilePath');
  callerSignal?.throwIfAborted();
  if (activeSources >= 2) throw Object.assign(new Error('External Git source preparation is busy; retry after a build finishes'), { status: 429 });
  activeSources++;

  const controller = new AbortController();
  const { signal } = controller;
  const operations = new Set();
  const streams = new Set();
  let dir, repo, gitEnv, configs, monitor, scan, cleaning, prepared = false, archived = false;
  const abort = error => controller.abort(error instanceof Error ? error : new Error(String(error || 'External Git source aborted')));
  const forwardAbort = () => abort(callerSignal.reason);
  callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => abort(new DOMException('External Git source timed out', 'TimeoutError')), timeoutMs);
  timer.unref();

  function cleanup() {
    if (cleaning) return cleaning;
    prepared = false;
    cleaning = (async () => {
      clearTimeout(timer);
      clearInterval(monitor);
      callerSignal?.removeEventListener('abort', forwardAbort);
      abort(new Error('External Git source cleaned up'));
      await Promise.allSettled([...operations].map(op => op.done));
      await scan?.catch(() => {});
      try {
        // dir is ONLY the value returned by mkdtemp, never a caller-owned path.
        if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } finally { activeSources--; }
    })();
    return cleaning;
  }

  // During acquisition the catch below owns cleanup, including in-flight mkdir.
  signal.addEventListener('abort', () => {
    for (const stream of streams) stream.destroy(signal.reason);
    if (prepared) void cleanup().catch(() => {});
  }, { once: true });

  function run(args, streaming = false) {
    signal.throwIfAborted();
    const child = spawn('git', [...configs, ...args], {
      cwd: repo, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      windowsHide: true, detached: process.platform !== 'win32',
    });
    const output = streaming ? new PassThrough() : null;
    let stdout = [], stderr = [], outBytes = 0, errBytes = 0, failure, stopping, exited = false;
    let resolveDone, rejectDone;
    const op = { done: new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }) };
    operations.add(op);
    // A streaming caller receives errors on output, not an unobserved promise.
    void op.done.catch(() => {});

    function stop(error) {
      failure ||= error;
      output?.destroy(failure);
      if (stopping || exited) return;
      stopping = (async () => {
        if (process.platform === 'win32' && child.pid) {
          // child.kill() alone leaves git-remote-https/index-pack running on Windows.
          await new Promise(resolve => {
            const killer = spawn(path.join(gitEnv.SystemRoot || gitEnv.WINDIR, 'System32', 'taskkill.exe'),
              ['/PID', String(child.pid), '/T', '/F'], {
                env: gitEnv, stdio: 'ignore', shell: false, windowsHide: true, timeout: 5000, killSignal: 'SIGKILL',
              });
            killer.once('error', resolve);
            killer.once('close', resolve);
          });
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      })().catch(() => {}).finally(() => { child.kill('SIGKILL'); });
    }
    const onAbort = () => stop(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    const fail = error => { stop(error); abort(error); };
    child.once('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.stdout.on('data', chunk => {
      outBytes += chunk.length;
      if (outBytes > (streaming ? maxBytes : MAX_OUTPUT)) {
        fail(new Error(`External Git ${streaming ? 'archive' : 'stdout'} exceeds the size limit`));
      } else if (!streaming) stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      errBytes += chunk.length;
      if (errBytes > MAX_OUTPUT) fail(new Error('External Git stderr exceeds the size limit'));
      else stderr.push(chunk);
    });
    if (output) {
      streams.add(output);
      output.on('error', fail);
      output.on('close', () => {
        streams.delete(output);
        if (!output.readableEnded) fail(output.errored || new Error('External Git archive consumer closed the stream'));
      });
      // Delay EOF until Git exits successfully, including errors after stdout EOF.
      child.stdout.pipe(output, { end: false });
    }
    child.once('close', async code => {
      exited = true;
      if (!failure && code !== 0) {
        fail(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 1000)}`));
      }
      await stopping;
      signal.removeEventListener('abort', onAbort);
      operations.delete(op);
      if (failure) rejectDone(failure);
      else {
        output?.end();
        resolveDone(streaming ? undefined : Buffer.concat(stdout).toString('utf8'));
      }
      stdout = stderr = [];
    });
    if (signal.aborted) onAbort();
    return output || op.done;
  }

  try {
    const check = await assertPublicUrl(url, { allowHttp: false, signal });
    signal.throwIfAborted();
    if (!check.ok) throw Object.assign(check.error || invalid(check.message), { status: 400 });
    if (!check.addresses.length || check.addresses.some(({ address, family }) => isIP(address) !== family || isPrivateAddress(address))) {
      throw invalid('External Git host must resolve exclusively to public IP addresses');
    }
    // Pin one address permanently (no '+' TTL). Prefer IPv4; no retry via DNS.
    const address = check.addresses.find(a => a.family === 4) || check.addresses[0];
    const pin = `${check.url.hostname}:443:${address.family === 6 ? `[${address.address}]` : address.address}`;
    dir = await mkdtemp(path.join(tempRoot, 'nixre-external-git-'));
    repo = path.join(dir, 'repo.git');
    const home = path.join(dir, 'home');
    const empty = path.join(dir, 'empty');
    for (const p of [repo, home, empty]) await mkdir(p);
    // Git for Windows cannot use Node's \\.\nul device path as a config file.
    const emptyConfig = path.join(home, 'empty-config');
    await writeFile(emptyConfig, '', { flag: 'wx' });
    gitEnv = {};
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE']) {
      const inherited = Object.keys(env).find(name => name.toLowerCase() === key.toLowerCase());
      if (inherited) gitEnv[key] = env[inherited];
    }
    Object.assign(gitEnv, {
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, APPDATA: home, LOCALAPPDATA: home,
      TMPDIR: dir, TMP: dir, TEMP: dir, LC_ALL: 'C', LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
      GIT_ALLOW_PROTOCOL: 'https', GIT_PROTOCOL_FROM_USER: '0', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_LFS_SKIP_SMUDGE: '1', GIT_LITERAL_PATHSPECS: '1', GIT_SMART_HTTP: '1',
      GIT_CEILING_DIRECTORIES: dir,
    });
    configs = [
      `core.hooksPath=${empty}`, `core.attributesFile=${emptyConfig}`, 'core.askPass=',
      'credential.helper=', 'credential.interactive=false',
      'http.proxy=', 'http.followRedirects=false', 'http.sslVerify=true',
      'http.emptyAuth=false', 'http.delegation=none', 'http.extraHeader=', 'http.saveCookies=false',
      'http.curloptResolve=', `http.curloptResolve=${pin}`,
      'protocol.allow=never', 'protocol.https.allow=always', 'protocol.http.allow=never',
      'protocol.file.allow=never', 'protocol.ext.allow=never', 'protocol.ssh.allow=never',
      'submodule.recurse=false', 'fetch.recurseSubmodules=false', 'fetch.fsckObjects=true',
      'transfer.fsckObjects=true', 'fetch.unpackLimit=1', 'fetch.uriprotocols=', 'transfer.bundleURI=false',
      'gc.auto=0', 'maintenance.auto=false', 'pack.threads=1', 'protocol.version=2',
    ].flatMap(value => ['-c', value]);
    const version = /^git version (\d+)\.(\d+)\./.exec(await run(['--version']));
    if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 37)) {
      throw new Error('External Git sources require Git 2.37 or newer for secure http.curloptResolve DNS pinning');
    }
    await run(['init', '--bare', `--template=${empty}`, '.']);
    // Build contexts must not silently lose Dockerfiles via export-ignore or run
    // export-subst expansions. info/attributes overrides attributes in the tree.
    await mkdir(path.join(repo, 'info'), { recursive: true });
    await writeFile(path.join(repo, 'info', 'attributes'), '* -export-ignore -export-subst\n');
    const checkSize = () => scan ||= checkTempSize(dir, maxBytes, signal).finally(() => { scan = null; });
    monitor = setInterval(() => { void checkSize().catch(abort); }, monitorIntervalMs);
    monitor.unref();
    // Depth also rejects dumb HTTP before it can fetch attacker-supplied alternates.
    await run(['fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', '--quiet', '--', url, safeRef]);
    const sha = (await run(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error('Git returned an invalid commit SHA');
    const tree = root === '.' ? `${sha}^{tree}` : `${sha}:${root}`;
    if ((await run(['cat-file', '-t', tree])).trim() !== 'tree') throw invalid('rootDir must be an existing directory at the resolved commit');
    const entry = await run(['ls-tree', '-z', '--full-tree', tree, '--', dockerfile]);
    const match = /^(100644|100755) blob (?:[a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)\0$/.exec(entry);
    if (!match || match[2] !== dockerfile) throw invalid('dockerfilePath must name an existing regular file inside rootDir, not a symlink, directory or submodule');
    const message = (await run(['log', '-1', '--format=%s', '--no-show-signature', sha, '--'])).trim();
    await checkSize();
    signal.throwIfAborted();
    prepared = true;
    return {
      sha, message,
      archive: async () => {
        signal.throwIfAborted();
        if (archived) throw new Error('External Git archive can only be consumed once');
        archived = true;
        try {
          const output = run(['archive', '--format=tar', root === '.' ? sha : `${sha}:${root}`], true);
          output.once('end', () => { clearTimeout(timer); clearInterval(monitor); });
          return output;
        } catch (error) { await cleanup(); throw error; }
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
