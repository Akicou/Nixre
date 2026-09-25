// Production IO for Nixre Actions: git reads on the bare repos, and a Docker
// job runner. Kept thin — the engine (actions.js) holds the behaviour and is
// tested with fakes.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { repoDir, listTree, readBlob } from '../git/repo.js';
import { assertSafeRef, getDocker, resolveRef } from './deployDrivers.js';
import { spawnedContainerNetwork } from './dockerNetwork.js';

const exec = promisify(execFile);
const MAX_WORKFLOW_BYTES = 256 * 1024;
const MAX_LINE = 8192;
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const STATE_DIR = '/tmp/_nixre';

// --- git -----------------------------------------------------------------------------

export const git = {
  async listDir(space, repo, sha, dir) {
    return listTree(space, repo, assertSafeRef(sha), dir);
  },
  async readFile(space, repo, sha, filePath) {
    const { content, size } = await readBlob(space, repo, assertSafeRef(sha), filePath);
    if (size > MAX_WORKFLOW_BYTES) throw new Error(`${filePath} is larger than 256 KB`);
    return content.toString('utf8');
  },
  resolveRef,
  /** Files changed between two revisions; `mergeBase` compares a...b. */
  async changedFiles(space, repo, from, to, { mergeBase = false } = {}) {
    const a = assertSafeRef(from);
    const b = assertSafeRef(to);
    const { stdout } = await exec(
      'git',
      ['-C', repoDir(space, repo), 'diff', '--name-only', '-z', mergeBase ? `${a}...${b}` : `${a}..${b}`, '--'],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.split('\0').filter(Boolean);
  },
};

// --- docker runner --------------------------------------------------------------------

function parseBytes(value, fallback) {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(String(value ?? '').trim());
  if (!m) return fallback;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

/** Split a byte stream into lines, calling `onLine` for each. */
function lineSink(onLine) {
  let buf = '';
  return {
    write(chunk) {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, idx).slice(0, MAX_LINE));
        buf = buf.slice(idx + 1);
      }
      if (buf.length > MAX_LINE) {
        onLine(buf.slice(0, MAX_LINE));
        buf = '';
      }
    },
    end() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

async function dockerOrThrow() {
  const docker = await getDocker();
  if (!docker) throw new Error('Docker is not available to nixre-core, so jobs cannot run');
  return docker;
}

async function ensureImage(docker, image, onLog, signal) {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
  onLog(`Pulling image ${image}`);
  const stream = await docker.pull(image);
  const seen = new Map();
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      stream.destroy?.();
      reject(new Error('Cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    docker.modem.followProgress(
      stream,
      err => {
        signal?.removeEventListener('abort', onAbort);
        if (err) reject(new Error(`Could not pull ${image}: ${err.message}`));
        else resolve();
      },
      evt => {
        if (evt.error) return;
        // One line per layer state change, not per progress tick.
        const key = evt.id || '';
        if (!evt.status || /^(Downloading|Extracting|Waiting)$/.test(evt.status) || seen.get(key) === evt.status) return;
        seen.set(key, evt.status);
        onLog(key ? `${key}: ${evt.status}` : evt.status);
      },
    );
  });
}

/** Clone the bare repo at `sha` into a temp dir and return a tar stream of it. */
async function checkoutTar(space, repo, sha, serverUrl) {
  const bare = repoDir(space, repo);
  const safe = assertSafeRef(sha);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nixre-ci-'));
  const git_ = args => exec('git', args, { maxBuffer: 16 * 1024 * 1024 });
  try {
    await git_(['clone', '--quiet', '--no-checkout', '--', bare, dir]);
    try {
      await git_(['-C', dir, 'checkout', '--quiet', '--detach', safe]);
    } catch {
      // Not reachable from a branch or tag (e.g. the branch moved): fetch it.
      await git_(['-C', dir, 'fetch', '--quiet', '--', bare, safe]);
      await git_(['-C', dir, 'checkout', '--quiet', '--detach', safe]);
    }
    const origin = serverUrl ? `${serverUrl.replace(/\/$/, '')}/git/${space}/${repo}.git` : '';
    if (origin) await git_(['-C', dir, 'remote', 'set-url', 'origin', origin]);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`Checkout failed: ${err.message.split('\n')[0]}`);
  }
  const tar = spawn('tar', ['-C', dir, '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const cleanup = () => void rm(dir, { recursive: true, force: true });
  tar.on('close', cleanup);
  tar.on('error', cleanup);
  return tar.stdout;
}

/** Run a command in the container; resolves to { code }. */
async function dockerExec(container, docker, { cmd, env = [], workdir, onStdout, onStderr, signal }) {
  const ex = await container.exec({
    Cmd: cmd,
    Env: env,
    WorkingDir: workdir,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await ex.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  const err = new PassThrough();
  out.on('data', d => onStdout?.(d));
  err.on('data', d => onStderr?.(d));
  docker.modem.demuxStream(stream, out, err);
  await new Promise(resolve => {
    const done = () => {
      signal?.removeEventListener('abort', done);
      resolve();
    };
    stream.on('end', done);
    stream.on('close', done);
    stream.on('error', done);
    signal?.addEventListener('abort', done, { once: true });
  });
  if (signal?.aborted) return { code: 137 };
  const info = await ex.inspect().catch(() => ({ ExitCode: 1 }));
  return { code: info.ExitCode ?? 137 };
}

export function createDockerRunner({ serverUrl = process.env.NIXRE_PUBLIC_URL || '' } = {}) {
  const memory = parseBytes(process.env.NIXRE_ACTIONS_MEMORY, 4 * 1024 ** 3);
  const nanoCpus = Math.round(Number(process.env.NIXRE_ACTIONS_CPUS || 2) * 1e9);

  return {
    async start({ image, space, repo, sha, runId, jobId, env = {}, signal, onLog }) {
      const docker = await dockerOrThrow();
      await ensureImage(docker, image, onLog, signal);
      const network = await spawnedContainerNetwork(docker, {
        preferred: process.env.NIXRE_ACTIONS_NETWORK || process.env.NIXRE_APPS_NETWORK,
        role: 'ci',
      });
      const container = await docker.createContainer({
        name: `nixre-ci-r${runId}-j${jobId}`,
        Image: image,
        // Keep the container alive; steps run through `docker exec`.
        Entrypoint: ['/bin/sh', '-c', 'trap "exit 0" TERM INT; while :; do sleep 3600 & wait $!; done'],
        Cmd: [],
        WorkingDir: '/workspace',
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        Labels: {
          'nixre.actions': 'true',
          'nixre.actions.run': String(runId),
          'nixre.actions.job': String(jobId),
          'nixre.repo': `${space}/${repo}`,
        },
        HostConfig: {
          Memory: memory,
          NanoCpus: nanoCpus,
          PidsLimit: Number(process.env.NIXRE_ACTIONS_PIDS_LIMIT || 2048),
          Init: true,
          // Default capabilities minus the network/device ones CI never needs;
          // package managers (apt drops to _apt) still work as root.
          CapDrop: ['NET_RAW', 'MKNOD', 'AUDIT_WRITE'],
          SecurityOpt: ['no-new-privileges:true'],
        },
        NetworkingConfig: { EndpointsConfig: { [network]: {} } },
      });
      const handle = { container, docker, hasBash: false, basePath: DEFAULT_PATH };
      try {
        await container.start();
        onLog(`Checking out ${space}/${repo} at ${String(sha).slice(0, 12)}`);
        const tar = await checkoutTar(space, repo, sha, serverUrl);
        await container.putArchive(tar, { path: '/workspace' });
        const setup = [
          `mkdir -p ${STATE_DIR}`,
          `: > ${STATE_DIR}/env; : > ${STATE_DIR}/output; : > ${STATE_DIR}/path; : > ${STATE_DIR}/summary`,
          "command -v git >/dev/null 2>&1 && git config --global --add safe.directory '*' || true",
        ].join('; ');
        await dockerExec(container, docker, { cmd: ['/bin/sh', '-c', setup], workdir: '/' });
        const probe = await dockerExec(container, docker, { cmd: ['/bin/sh', '-c', 'command -v bash'], workdir: '/' });
        handle.hasBash = probe.code === 0;
        const info = await container.inspect();
        const pathVar = (info.Config?.Env || []).find(e => e.startsWith('PATH='));
        if (pathVar) handle.basePath = pathVar.slice(5);
      } catch (err) {
        await container.remove({ force: true }).catch(() => {});
        throw err;
      }
      const onAbort = () => void container.kill().catch(() => {});
      signal?.addEventListener('abort', onAbort, { once: true });
      handle.detach = () => signal?.removeEventListener('abort', onAbort);
      return handle;
    },

    async exec(handle, { script, shell, env, workdir, onLine, signal, timeoutMs }) {
      const { NIXRE_PATH_PREPEND: prepend, ...rest } = env;
      if (prepend) rest.PATH = `${prepend}:${handle.basePath}`;
      const useBash = shell === 'bash' || (!shell && handle.hasBash);
      let cmd;
      if (shell === 'python') cmd = ['python3', '-c', script];
      else if (shell === 'node') cmd = ['node', '-e', script];
      else if (useBash) cmd = ['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', script];
      else cmd = ['sh', '-e', '-c', script];
      const out = lineSink(onLine);
      const err = lineSink(onLine);
      // A step timeout ends the job: an exec cannot be killed on its own, so
      // the container goes, which is what the job-level abort does anyway.
      const timer = timeoutMs
        ? setTimeout(() => {
            onLine(`Step timed out after ${Math.round(timeoutMs / 60000)} minutes`);
            void handle.container.kill().catch(() => {});
          }, timeoutMs)
        : null;
      try {
        const { code } = await dockerExec(handle.container, handle.docker, {
          cmd,
          env: Object.entries(rest).map(([k, v]) => `${k}=${v}`),
          workdir,
          onStdout: d => out.write(d),
          onStderr: d => err.write(d),
          signal,
        });
        return code;
      } finally {
        if (timer) clearTimeout(timer);
        out.end();
        err.end();
      }
    },

    async collectFiles(handle) {
      let text = '';
      await dockerExec(handle.container, handle.docker, {
        cmd: [
          '/bin/sh',
          '-c',
          `for f in output env path; do printf '\\036%s\\n' "$f"; cat ${STATE_DIR}/$f 2>/dev/null; : > ${STATE_DIR}/$f; done`,
        ],
        workdir: '/',
        onStdout: d => (text += d.toString('utf8')),
      });
      const files = {};
      for (const part of text.split('\u001e').slice(1)) {
        const nl = part.indexOf('\n');
        files[part.slice(0, nl)] = part.slice(nl + 1);
      }
      return files;
    },

    async destroy(handle) {
      handle.detach?.();
      await handle.container.remove({ force: true });
    },

    /** Remove job containers no live job owns (after a restart). */
    async cleanupOrphans(activeJobIds) {
      const docker = await getDocker();
      if (!docker) return;
      const list = await docker.listContainers({ all: true, filters: { label: ['nixre.actions=true'] } });
      for (const c of list) {
        if (activeJobIds.has(Number(c.Labels?.['nixre.actions.job']))) continue;
        await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
      }
    },
  };
}
