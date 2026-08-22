// Agent sandbox — Docker-backed persistent workspace for run_command.
//
// One container + named volume per (user, conversation, repo). While the
// container runs, a single long-lived bash in nixre-core receives commands so
// cd, env, and installs persist between tool calls. No JSON session files:
// on wake after idle stop we git-sync tracked files from the bare repo and
// spawn a fresh shell at /workspace/repo.
//
// Idle (default 15m): docker stop — volume kept. Next activity: docker start,
// git resync, new shell.

import crypto from 'node:crypto';
import { access, constants } from 'node:fs/promises';
import { repoDir, REPOS_ROOT } from '../git/repo.js';

const DOCKER_SOCKET = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') || '/var/run/docker.sock';
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'nixre-agent-sandbox:latest';
const IDLE_MS = Number(process.env.SANDBOX_IDLE_MS || 15 * 60 * 1000);
const SWEEP_MS = Number(process.env.SANDBOX_SWEEP_MS || 60 * 1000);
const VOLUME_TTL_MS = Number(process.env.SANDBOX_VOLUME_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const MAX_CMD_MS = Number(process.env.SANDBOX_CMD_MS || 120_000);
const MAX_CMD_BYTES = 32 * 1024;
const WORK_DIR = '/workspace/repo';
const MARKER = '__NIXRE_EXIT__';

let docker = null;
let dockerChecked = false;
let dockerAvailable = false;

/** @type {Map<string, { stream: import('stream').Duplex, buf: string, waiters: Array<{ resolve: Function, reject: Function, timer: NodeJS.Timeout }>, busy: boolean }>} */
const shells = new Map();

/** @type {Map<string, number>} */
const lastActivity = new Map();

function sessionKey(userId, conversationId, repoPath) {
  return `${userId}:${conversationId}:${repoPath}`;
}

function hashId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 20);
}

function containerName(key) {
  return `nixre-sb-${hashId(key)}`;
}

function volumeName(key) {
  return `nixre-sb-vol-${hashId(key)}`;
}

export async function isSandboxEnabled() {
  if (dockerChecked) return dockerAvailable;
  dockerChecked = true;
  try {
    await access(DOCKER_SOCKET, constants.R_OK | constants.W_OK);
    const mod = await import('dockerode');
    const Docker = mod.default || mod;
    docker = new Docker({ socketPath: DOCKER_SOCKET });
    await docker.ping();
    dockerAvailable = true;
  } catch {
    docker = null;
    dockerAvailable = false;
  }
  return dockerAvailable;
}

function touch(key) {
  const now = Date.now();
  lastActivity.set(key, now);
  return now;
}

function closeShell(key) {
  const sh = shells.get(key);
  if (!sh) return;
  shells.delete(key);
  for (const w of sh.waiters) {
    clearTimeout(w.timer);
    w.reject(new Error('Sandbox shell closed'));
  }
  sh.waiters = [];
  try {
    sh.stream.end();
  } catch {
    /* ignore */
  }
}

async function dockerExec(containerId, cmd, { stdin } = {}) {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: Boolean(stdin),
  });
  const stream = await exec.start(stdin ? { hijack: true, stdin: true } : {});
  if (stdin) {
    stream.write(stdin);
    stream.end();
  }
  const chunks = [];
  await new Promise((resolve, reject) => {
    container.modem.demuxStream(
      stream,
      { write: d => chunks.push(Buffer.from(d)) },
      { write: d => chunks.push(Buffer.from(d)) },
    );
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const inspect = await exec.inspect();
  return { output: Buffer.concat(chunks).toString('utf8'), code: inspect.ExitCode ?? 1 };
}

async function ensureVolume(name) {
  try {
    await docker.getVolume(name).inspect();
  } catch {
    await docker.createVolume({ Name: name });
  }
}

async function syncRepo(containerId, space, repo) {
  const bare = repoDir(space, repo);
  const script = `set -eu
BARE=${JSON.stringify(bare)}
WORK=${JSON.stringify(WORK_DIR)}
mkdir -p "$(dirname "$WORK")"
if [ ! -d "$WORK/.git" ]; then
  git clone --quiet "$BARE" "$WORK"
else
  git -C "$WORK" fetch --quiet "$BARE" '+HEAD:refs/remotes/nixre/upstream' 2>/dev/null || git clone --quiet "$BARE" "$WORK"
  git -C "$WORK" reset --hard refs/remotes/nixre/upstream 2>/dev/null || git -C "$WORK" reset --hard HEAD
fi
`;
  const { output, code } = await dockerExec(containerId, ['bash', '-lc', script]);
  if (code !== 0) {
    throw new Error(`Git sync failed (exit ${code}): ${output.slice(0, 400)}`);
  }
}

async function createContainer(key, userId, conversationId, repoPath, space, repo) {
  const name = containerName(key);
  const vol = volumeName(key);
  await ensureVolume(vol);
  touch(key);
  const container = await docker.createContainer({
    name,
    Image: SANDBOX_IMAGE,
    WorkingDir: '/workspace',
    Labels: {
      'nixre.sandbox': 'true',
      'nixre.user': userId,
      'nixre.conversation': conversationId,
      'nixre.repo': repoPath,
      'nixre.lastActivity': String(Date.now()),
    },
    HostConfig: {
      Binds: [`${vol}:/workspace`, `${REPOS_ROOT}:/data/repos:ro`],
      Memory: Number(process.env.SANDBOX_MEMORY_BYTES || 2 * 1024 * 1024 * 1024),
      NanoCpus: Number(process.env.SANDBOX_NANO_CPUS || 2 * 1e9),
      Init: true,
    },
    Cmd: ['sleep', 'infinity'],
  });
  await container.start();
  await syncRepo(container.id, space, repo);
  return container.id;
}

async function ensureRunningContainer(key, userId, conversationId, repoPath, space, repo) {
  const name = containerName(key);
  let container;
  let created = false;
  let resumed = false;

  try {
    container = docker.getContainer(name);
    await container.inspect();
  } catch {
    container = null;
  }

  if (!container) {
    try {
      const id = await createContainer(key, userId, conversationId, repoPath, space, repo);
      container = docker.getContainer(id);
      created = true;
    } catch (err) {
      if (err.statusCode === 409) {
        container = docker.getContainer(name);
      } else {
        throw err;
      }
    }
  }

  let info = await container.inspect();
  if (info.State.Status !== 'running') {
    await container.start();
    info = await container.inspect();
    resumed = true;
    closeShell(key);
  }

  if (created || resumed) {
    await syncRepo(info.Id, space, repo);
    closeShell(key);
  }

  touch(key);
  return info.Id;
}

async function spawnShell(key, containerId) {
  closeShell(key);
  const container = docker.getContainer(containerId);
  const execInstance = await container.exec({
    Cmd: ['bash', '--norc', '--noprofile'],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await execInstance.start({ hijack: true, stdin: true });
  const state = { stream, buf: '', waiters: [], busy: false };
  const append = chunk => {
    state.buf += chunk.toString('utf8');
    drainWaiters(state);
  };
  docker.modem.demuxStream(stream, { write: append }, { write: append });
  stream.on('end', () => {
    shells.delete(key);
    for (const w of state.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('Sandbox shell exited'));
    }
  });
  stream.write(`cd ${WORK_DIR} 2>/dev/null || cd /workspace\n`);
  shells.set(key, state);
  return state;
}

function drainWaiters(state) {
  while (state.waiters.length > 0) {
    const idx = state.buf.indexOf(`\n${MARKER}:`);
    if (idx === -1) {
      const solo = state.buf.match(new RegExp(`^${MARKER}:(\\d+)$`, 'm'));
      if (!solo) return;
    }
    const nl = state.buf.indexOf(`\n${MARKER}:`);
    let markerAt;
    let before;
    let afterMarkerLine;
    if (nl >= 0) {
      before = state.buf.slice(0, nl);
      const rest = state.buf.slice(nl + 1);
      const lineEnd = rest.indexOf('\n');
      const markerLine = lineEnd >= 0 ? rest.slice(0, lineEnd) : rest;
      afterMarkerLine = lineEnd >= 0 ? rest.slice(lineEnd + 1) : '';
      markerAt = markerLine;
    } else {
      const m = state.buf.match(new RegExp(`^${MARKER}:(\\d+)$`, 'm'));
      if (!m) return;
      before = state.buf.slice(0, m.index).replace(/\n$/, '');
      afterMarkerLine = state.buf.slice(m.index + m[0].length);
      if (afterMarkerLine.startsWith('\n')) afterMarkerLine = afterMarkerLine.slice(1);
      markerAt = m[0];
    }
    const codeMatch = String(markerAt).match(new RegExp(`^${MARKER}:(\\d+)$`));
    if (!codeMatch) return;
    state.buf = afterMarkerLine;
    const w = state.waiters.shift();
    clearTimeout(w.timer);
    state.busy = false;
    const exitCode = Number(codeMatch[1]);
    w.resolve({ exitCode, output: before });
  }
}

async function execInShell(key, containerId, command) {
  let state = shells.get(key);
  if (!state || state.stream.destroyed) {
    state = await spawnShell(key, containerId);
  }
  if (state.busy) {
    throw new Error('Sandbox shell busy (concurrent run_command not supported)');
  }
  state.busy = true;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.busy = false;
      const i = state.waiters.findIndex(w => w.timer === timer);
      if (i >= 0) state.waiters.splice(i, 1);
      try {
        state.stream.write('\x03');
      } catch {
        /* ignore */
      }
      reject(new Error(`Command timed out after ${MAX_CMD_MS / 1000}s`));
    }, MAX_CMD_MS);

    state.waiters.push({
      resolve: ({ exitCode, output }) => {
        let out = output;
        if (out.length > MAX_CMD_BYTES) {
          out = `${out.slice(0, MAX_CMD_BYTES)}\n… (output truncated at ${MAX_CMD_BYTES} bytes)`;
        }
        resolve({ output: `exit code: ${exitCode}\n${out}`, exitCode });
      },
      reject,
      timer,
    });

    if (!command.includes('\n')) {
      state.stream.write(`( ${command} )\n`);
    } else {
      state.stream.write(`${command}\n`);
    }
    state.stream.write(`printf '${MARKER}:%s\\n' $?\n`);
    drainWaiters(state);
  });
}

/** Keep the sandbox awake while the user is chatting (even before tools run). */
export async function touchSandbox({ userId, conversationId, repoPath, space, repo }) {
  if (!(await isSandboxEnabled())) return;
  if (!userId || !conversationId || !repoPath) return;
  const key = sessionKey(userId, conversationId, repoPath);
  touch(key);
  try {
    const container = docker.getContainer(containerName(key));
    const info = await container.inspect();
    if (info.State.Status !== 'running') {
      await ensureRunningContainer(key, userId, conversationId, repoPath, space, repo);
    }
  } catch {
    /* no container yet — created on first run_command */
  }
}

export async function runCommandInSandbox({ userId, conversationId, repoPath, space, repo, command }) {
  if (!(await isSandboxEnabled())) {
    throw new Error('Agent sandbox unavailable (Docker socket not accessible)');
  }
  const key = sessionKey(userId, conversationId, repoPath);
  touch(key);
  const containerId = await ensureRunningContainer(key, userId, conversationId, repoPath, space, repo);
  return execInShell(key, containerId, command);
}

export async function writeFileInSandbox({
  userId,
  conversationId,
  repoPath,
  space,
  repo,
  filePath,
  content,
}) {
  if (!(await isSandboxEnabled())) {
    throw new Error('Agent sandbox unavailable (Docker socket not accessible)');
  }
  const key = sessionKey(userId, conversationId, repoPath);
  touch(key);
  const containerId = await ensureRunningContainer(key, userId, conversationId, repoPath, space, repo);
  const rel = String(filePath || '').replace(/\\/g, '/');
  const target = `${WORK_DIR}/${rel}`;
  const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : WORK_DIR;
  const b64 = Buffer.from(String(content ?? ''), 'utf8').toString('base64');
  const cmd = `mkdir -p ${JSON.stringify(parent)} && echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(target)}`;
  const { output, exitCode } = await execInShell(key, containerId, cmd);
  if (exitCode !== 0) {
    throw new Error(output || `write_file failed (exit ${exitCode})`);
  }
  return { output: `Wrote ${Buffer.byteLength(content ?? '', 'utf8')} bytes to ${rel}` };
}

async function stopContainerByName(name) {
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    if (info.State.Status === 'running') {
      await container.stop({ t: 5 });
    }
  } catch {
    /* already gone */
  }
}

async function removeVolumeByName(name) {
  try {
    await docker.getVolume(name).remove({ force: true });
  } catch {
    /* ignore */
  }
}

export function startSandboxSweeper() {
  if (!dockerAvailable) return;
  setInterval(async () => {
    try {
      const listed = await docker.listContainers({
        all: true,
        filters: { label: ['nixre.sandbox=true'] },
      });
      const now = Date.now();
      for (const row of listed) {
        const name = row.Names?.[0]?.replace(/^\//, '') || '';
        const labels = row.Labels || {};
        const keyGuess =
          labels['nixre.user'] && labels['nixre.conversation'] && labels['nixre.repo']
            ? sessionKey(labels['nixre.user'], labels['nixre.conversation'], labels['nixre.repo'])
            : null;
        const labelTime = Number(labels['nixre.lastActivity'] || 0);
        const memTime = keyGuess ? lastActivity.get(keyGuess) || 0 : 0;
        const last = Math.max(labelTime, memTime);
        if (last && now - last > IDLE_MS && row.State === 'running') {
          if (keyGuess) closeShell(keyGuess);
          await stopContainerByName(name);
        }
        if (last && now - last > VOLUME_TTL_MS && row.State !== 'running') {
          const vol = row.Mounts?.find(m => m.Destination === '/workspace')?.Name;
          if (vol) await removeVolumeByName(vol);
          try {
            await docker.getContainer(row.Id).remove({ force: true });
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      console.error('sandbox sweeper:', err.message);
    }
  }, SWEEP_MS).unref();
}

export async function initSandbox() {
  const ok = await isSandboxEnabled();
  if (ok) {
    console.log(`Agent sandbox enabled (image=${SANDBOX_IMAGE}, idle=${IDLE_MS / 1000}s)`);
    startSandboxSweeper();
  } else {
    console.log('Agent sandbox disabled — run_command uses ephemeral clones (no Docker socket)');
  }
  return ok;
}
