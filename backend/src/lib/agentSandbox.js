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
import os from 'node:os';
import { access, constants } from 'node:fs/promises';
import { repoDir, REPOS_ROOT } from '../git/repo.js';
import { pool } from '../db/pool.js';
import { newPatSecret, sha256 } from './auth.js';
import { getDecryptedSecret } from './userSecrets.js';
import { parseWorkspacePath, workspaceGitDir } from './workspaces.js';

const DOCKER_SOCKET = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') || '/var/run/docker.sock';
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'nixre-agent-sandbox:latest';
const IDLE_MS = Number(process.env.SANDBOX_IDLE_MS || 15 * 60 * 1000);
const SWEEP_MS = Number(process.env.SANDBOX_SWEEP_MS || 60 * 1000);
const VOLUME_TTL_MS = Number(process.env.SANDBOX_VOLUME_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const MAX_CMD_MS = Number(process.env.SANDBOX_CMD_MS || 120_000);
const MAX_CMD_BYTES = 32 * 1024;
const WORK_DIR = '/workspace/repo';
const CREDS_FILE = '/workspace/.agent-creds';
const GIT_CREDS_STORE = '/workspace/.git-credentials';
const GITHUB_CREDS_FILE = '/workspace/.github-creds';
const GITHUB_TOKEN_FILE = '/workspace/.github-token';
// Where the sandbox reaches core's git smart-HTTP endpoint. The sandbox
// container is attached to core's docker network so this name resolves.
const CORE_GIT_URL = process.env.CORE_URL || 'http://nixre-core:3002';
const MARKER = '__NIXRE_EXIT__';

// git-credential-store line. URL-scoped `credential.http://host:port.helper`
// often never matches, so git push hits core with no Basic auth (401).
export function gitCredentialStoreLine(origin, username, password) {
  const u = new URL(String(origin || 'http://nixre-core:3002'));
  u.username = String(username || 'x');
  u.password = String(password || '');
  return u.href.replace(/\/$/, '');
}

let docker = null;
let dockerChecked = false;
let dockerAvailable = false;
let sweeperStarted = false;

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

// Only success is cached: the docker socket can answer a beat after the
// container starts (Docker Desktop proxies it), and a failed check at boot
// must not disable the sandbox for the process lifetime.
export async function isSandboxEnabled() {
  if (dockerAvailable) return true;
  try {
    await access(DOCKER_SOCKET, constants.R_OK | constants.W_OK);
    const mod = await import('dockerode');
    const Docker = mod.default || mod;
    docker = new Docker({ socketPath: DOCKER_SOCKET });
    await docker.ping();
    dockerAvailable = true;
    dockerChecked = true;
  } catch {
    docker = null;
    dockerAvailable = false;
  }
  if (dockerAvailable && !sweeperStarted) {
    sweeperStarted = true;
    startSandboxSweeper();
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

// The sandbox pushes back into the hosted repo over core's git smart-HTTP
// endpoint (the ro mount is fetch-only). Auth is a short-lived PAT minted for
// the conversation's user, rewritten on every sync; it expires with the volume.
async function mintSandboxToken(key, uid) {
  const id = `agent-sbx-${hashId(key)}`;
  const token = `nxp_${id}_${newPatSecret()}`;
  const now = Date.now();
  await pool.query('DELETE FROM tokens WHERE id = $1', [id]);
  await pool.query(
    'INSERT INTO tokens (id, user_uid, secret_hash, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [id, uid, sha256(token), now, now + VOLUME_TTL_MS + 24 * 60 * 60 * 1000],
  );
  return token;
}

// Kind-aware workspace provisioning:
//   nixre        — clone/fetch from the hosted bare repo; pushes return to core.
//   github       — clone/fetch from the local read-only mirror of a github.com
//                  repo (kept fresh by core); pushes go straight to github.com
//                  with the user's stored PAT via the github.com credential helper.
//   unrestricted — no hosted source: just ensure an empty git scratch dir exists;
//                  github creds still load so the agent can clone/push anywhere.
async function syncRepo(containerId, repoPath, key, user) {
  const ws = parseWorkspacePath(repoPath);
  if (ws.kind === 'invalid') throw new Error(`Invalid workspace target '${repoPath}'`);
  const uid = user?.uid || '';
  const name = user?.name || 'Nixre Agent';
  const email = user?.email || 'agent@nixre.local';

  let credsSetup = '';
  let bareBlock = '';
  let workSync = `
mkdir -p "$WORK"
if [ ! -d "$WORK/.git" ]; then
  git init --quiet "$WORK"
fi
`;
  if (ws.kind === 'nixre') {
    try {
      const token = await mintSandboxToken(key, uid);
      // Credential helper serves the PAT only to core's endpoint; the push URL
      // and `git remote -v` stay clean (no token in .git/config or transcripts).
      const storeLine = gitCredentialStoreLine(CORE_GIT_URL, uid, token);
      bareBlock = `BARE=${JSON.stringify(repoDir(ws.space, ws.repo))}`;
      workSync = `
if [ ! -d "$WORK/.git" ]; then
  git clone --quiet "$BARE" "$WORK"
else
  git -C "$WORK" fetch --quiet "$BARE" '+HEAD:refs/remotes/nixre/upstream' 2>/dev/null || git clone --quiet "$BARE" "$WORK"
  git -C "$WORK" reset --hard refs/remotes/nixre/upstream 2>/dev/null || git -C "$WORK" reset --hard HEAD
fi
`;
      credsSetup = `
printf 'username=%s\\npassword=%s\\n' ${JSON.stringify(uid)} ${JSON.stringify(token)} > ${CREDS_FILE}
printf '%s\\n' ${JSON.stringify(storeLine)} > ${GIT_CREDS_STORE}
chmod 600 ${CREDS_FILE} ${GIT_CREDS_STORE}
git -C "$WORK" config --unset-all credential.helper >/dev/null 2>&1 || true
git -C "$WORK" config credential.helper ${JSON.stringify(`store --file=${GIT_CREDS_STORE}`)}
git -C "$WORK" config credential.useHttpPath false
git -C "$WORK" remote set-url --push origin ${JSON.stringify(`${CORE_GIT_URL}/git/${ws.space}/${ws.repo}.git`)}
`;
    } catch (err) {
      // DB unavailable — workspace still clones/fetches; push stays disabled.
      console.warn('sandbox token mint failed, push disabled:', err.message);
    }
  } else if (ws.kind === 'github') {
    // The mirror keeps refs/heads/* mirroring github.com, HEAD pointing at its
    // default branch — the same shape core's own bare repos have.
    bareBlock = `BARE=${JSON.stringify(workspaceGitDir(ws))}`;
    workSync = `
if [ ! -d "$WORK/.git" ]; then
  git clone --quiet "$BARE" "$WORK"
else
  git -C "$WORK" fetch --quiet "$BARE" '+HEAD:refs/remotes/nixre/upstream' 2>/dev/null || git clone --quiet "$BARE" "$WORK"
  git -C "$WORK" reset --hard refs/remotes/nixre/upstream 2>/dev/null || git -C "$WORK" reset --hard HEAD
fi
`;
    credsSetup = `
# Pushes bypass core entirely — straight to github.com over https (PAT helper below).
git -C "$WORK" remote set-url --push origin ${JSON.stringify(`https://github.com/${ws.fullName}.git`)}
`;
  }

  let githubSetup = `
rm -f ${GITHUB_CREDS_FILE} ${GITHUB_TOKEN_FILE}
git -C "$WORK" config --unset-all credential.https://github.com.helper >/dev/null 2>&1 || true
`;
  try {
    const gh = uid ? await getDecryptedSecret(uid, 'github') : null;
    if (gh) {
      githubSetup = `
printf 'username=%s\\npassword=%s\\n' 'x-access-token' ${JSON.stringify(gh)} > ${GITHUB_CREDS_FILE}
printf '%s' ${JSON.stringify(gh)} > ${GITHUB_TOKEN_FILE}
chmod 600 ${GITHUB_CREDS_FILE} ${GITHUB_TOKEN_FILE}
git -C "$WORK" config credential.https://github.com.helper "!f() { cat ${GITHUB_CREDS_FILE} 2>/dev/null; }; f"
`;
    }
  } catch (err) {
    console.warn('sandbox github secret load failed:', err.message);
  }
  const script = `set -eu
${bareBlock}
WORK=${JSON.stringify(WORK_DIR)}
# The ro-mounted bare repos are owned by a different uid than the sandbox user.
git config --global --add safe.directory '*' >/dev/null 2>&1 || true
mkdir -p "$(dirname "$WORK")"
${workSync}
git -C "$WORK" config user.name ${JSON.stringify(name)}
git -C "$WORK" config user.email ${JSON.stringify(email)}
${credsSetup}
${githubSetup}`;
  const { output, code } = await dockerExec(containerId, ['bash', '-lc', script]);
  if (code !== 0) {
    throw new Error(`Git sync failed (exit ${code}): ${output.slice(0, 400)}`);
  }
}

// The sandbox needs to reach core (git push over smart HTTP). Attach it to the
// same docker network core runs on; resolved once from core's own container.
let coreNetworkName;
async function coreNetwork() {
  if (coreNetworkName !== undefined) return coreNetworkName;
  coreNetworkName = '';
  try {
    const info = await docker.getContainer(os.hostname()).inspect();
    const names = Object.keys(info.NetworkSettings?.Networks || {});
    coreNetworkName = names[0] || '';
  } catch {
    /* not containerized or docker unreachable — sandbox stays on default bridge */
  }
  return coreNetworkName;
}

// The sandbox needs /data/repos mounted from the same place core gets it.
// Bind sources are resolved by the docker daemon on the HOST — core's own
// mount point (/data/repos) is usually not a valid host path (compose binds
// ./data/repos, Docker Desktop maps a Windows path). Inspect core's own
// container and use the mount's Source instead.
let reposHostPath;
async function reposBindSource() {
  if (reposHostPath !== undefined) return reposHostPath;
  reposHostPath = REPOS_ROOT;
  try {
    const info = await docker.getContainer(os.hostname()).inspect();
    const mount = (info.Mounts || []).find(m => m.Destination === REPOS_ROOT);
    if (mount?.Source) reposHostPath = mount.Source;
  } catch {
    /* not containerized — REPOS_ROOT is already a host path */
  }
  return reposHostPath;
}

async function createContainer(key, userId, conversationId, repoPath, space, repo, user) {
  const name = containerName(key);
  const vol = volumeName(key);
  await ensureVolume(vol);
  touch(key);
  const net = await coreNetwork();
  const reposSource = await reposBindSource();
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
      Binds: [`${vol}:/workspace`, `${reposSource}:/data/repos:ro`],
      Memory: Number(process.env.SANDBOX_MEMORY_BYTES || 2 * 1024 * 1024 * 1024),
      NanoCpus: Number(process.env.SANDBOX_NANO_CPUS || 2 * 1e9),
      Init: true,
    },
    ...(net ? { NetworkingConfig: { EndpointsConfig: { [net]: {} } } } : {}),
    Cmd: ['sleep', 'infinity'],
  });
  await container.start();
  try {
    await syncRepo(container.id, repoPath, key, user);
  } catch (err) {
    // A half-provisioned container (clone failed) would be reused without a
    // resync — remove it so the next attempt provisions cleanly.
    await container.remove({ force: true }).catch(() => {});
    throw err;
  }
  return container.id;
}

async function ensureRunningContainer(key, userId, conversationId, repoPath, space, repo, user) {
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
      const id = await createContainer(key, userId, conversationId, repoPath, space, repo, user);
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
    await syncRepo(info.Id, repoPath, key, user);
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
  const state = { stream, buf: '', waiters: [], busy: false, dead: false };
  const kill = err => {
    if (state.dead) return;
    state.dead = true;
    shells.delete(key);
    for (const w of state.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error(`Sandbox shell error (${err?.message || err || 'stream closed'})`));
    }
    state.waiters = [];
  };
  const append = chunk => {
    state.buf += chunk.toString('utf8');
    drainWaiters(state);
  };
  // A stream 'error' (EPIPE, socket reset, write-after-end) with no listener
  // is an uncaught exception — it takes the whole core process down and every
  // active agent job with it. Fail the pending command instead.
  stream.on('error', err => {
    console.error(`[agentSandbox] shell stream error for ${key}:`, err?.message || err);
    kill(err);
  });
  stream.on('close', () => kill(new Error('stream closed')));
  docker.modem.demuxStream(stream, { write: append }, { write: append });
  stream.on('end', () => {
    kill(new Error('Sandbox shell exited'));
  });
  try {
    stream.write(`[ -f ${GITHUB_TOKEN_FILE} ] && export GITHUB_TOKEN=$(cat ${GITHUB_TOKEN_FILE})\n`);
    stream.write(`cd ${WORK_DIR} 2>/dev/null || cd /workspace\n`);
  } catch (err) {
    kill(err);
    throw err;
  }
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

    const fail = err => {
      clearTimeout(timer);
      state.busy = false;
      reject(err);
    };

    state.waiters.push({
      resolve: ({ exitCode, output }) => {
        let out = output;
        if (out.length > MAX_CMD_BYTES) {
          out = `${out.slice(0, MAX_CMD_BYTES)}\n… (output truncated at ${MAX_CMD_BYTES} bytes)`;
        }
        resolve({ output: `exit code: ${exitCode}\n${out}`, exitCode });
      },
      reject: fail,
      timer,
    });

    try {
      if (!command.includes('\n')) {
        state.stream.write(`( ${command} )\n`);
      } else {
        state.stream.write(`${command}\n`);
      }
      state.stream.write(`printf '${MARKER}:%s\\n' $?\n`);
    } catch (err) {
      // Write on a closed/destroyed socket must fail the command, not the
      // process — an async 'error' event is handled by the spawnShell handler,
      // this catches the synchronous throw surface.
      state.stream.destroy?.();
      fail(new Error(`Sandbox shell unavailable (${err.message})`));
      return;
    }
    drainWaiters(state);
  });
}

/** Keep the sandbox awake while the user is chatting (even before tools run). */
export async function touchSandbox({ userId, conversationId, repoPath, space, repo, user }) {
  if (!(await isSandboxEnabled())) return;
  if (!userId || !conversationId || !repoPath) return;
  const key = sessionKey(userId, conversationId, repoPath);
  touch(key);
  try {
    const container = docker.getContainer(containerName(key));
    const info = await container.inspect();
    if (info.State.Status !== 'running') {
      await ensureRunningContainer(key, userId, conversationId, repoPath, space, repo, user);
    }
  } catch {
    /* no container yet — created on first run_command */
  }
}

export async function runCommandInSandbox({ userId, conversationId, repoPath, space, repo, user, command }) {
  if (!(await isSandboxEnabled())) {
    throw new Error('Agent sandbox unavailable (Docker socket not accessible)');
  }
  const key = sessionKey(userId, conversationId, repoPath);
  touch(key);
  const containerId = await ensureRunningContainer(key, userId, conversationId, repoPath, space, repo, user);
  return execInShell(key, containerId, command);
}

export async function writeFileInSandbox({
  userId,
  conversationId,
  repoPath,
  space,
  repo,
  user,
  filePath,
  content,
}) {
  if (!(await isSandboxEnabled())) {
    throw new Error('Agent sandbox unavailable (Docker socket not accessible)');
  }
  const key = sessionKey(userId, conversationId, repoPath);
  touch(key);
  const containerId = await ensureRunningContainer(key, userId, conversationId, repoPath, space, repo, user);
  const rel = String(filePath || '').replace(/\\/g, '/');
  const target = `${WORK_DIR}/${rel}`;
  const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : WORK_DIR;
  // One-shot exec with the content passed as exec stdin. Deliberately NOT the
  // persistent shell: a whole file as a single ~64KB base64 command line was
  // the only >2000-char write into the hijacked shell stream and could kill
  // the stream (and with an unhandled 'error' listener missing, the whole
  // core process). A dedicated exec also cannot collide with a busy
  // run_command shell.
  const b64 = Buffer.from(String(content ?? ''), 'utf8').toString('base64');
  const script = `set -eu\nmkdir -p ${JSON.stringify(parent)}\nbase64 -d > ${JSON.stringify(target)}\n`;
  const { output, code } = await dockerExec(containerId, ['bash', '-lc', script], { stdin: b64 });
  if (code !== 0) {
    throw new Error(output || `write_file failed (exit ${code})`);
  }
  return { output: `Wrote ${Buffer.byteLength(content ?? '', 'utf8')} bytes to ${rel}` };
}

// --- user attachments ---------------------------------------------------------
//
// Pasted/attached chat files are dropped into the sandbox workspace instead of
// being inlined into the provider request. They live under
// .nixre/attachments/<message-id>/ inside the repo workdir: readable with
// run_command, displayable via show_images, and kept out of `git status`
// through .git/info/exclude (local-only, never touches .gitignore).

const ATTACHMENTS_ROOT = '.nixre/attachments';

export function sanitizeAttachmentName(raw, fallbackExt = 'bin') {
  const base = String(raw || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim();
  const capped = (cleaned || `attachment.${fallbackExt}`).slice(0, 120);
  return /^\.+$/.test(capped) ? `attachment.${fallbackExt}` : capped;
}

export function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt' };
  return map[m] || (m.startsWith('image/') ? 'png' : 'bin');
}

/**
 * Write pasted chat attachments into the conversation's sandbox workspace.
 * files: [{ name, mime, data(Buffer) }]. Returns
 * { written: [{ name, path }], failed: [{ name, error }] }, or null when no
 * sandbox is available (caller falls back to inlining).
 */
export async function writeAttachmentFiles({
  userId,
  conversationId,
  repoPath,
  space,
  repo,
  user,
  groupId,
  files,
}) {
  if (!(await isSandboxEnabled())) return null;
  if (!userId || !conversationId || !repoPath || !Array.isArray(files) || files.length === 0) return null;
  const key = sessionKey(userId, conversationId, repoPath);
  let containerId;
  try {
    containerId = await ensureRunningContainer(key, userId, conversationId, repoPath, space, repo, user);
  } catch (err) {
    return { written: [], failed: files.map((f, i) => ({ index: i, name: f.name, error: err.message })), unavailable: false };
  }
  const group = sanitizeAttachmentName(groupId || `m${Date.now().toString(36)}`, 'm').replace(/\.[a-z0-9]+$/i, '');
  const dir = `${WORK_DIR}/${ATTACHMENTS_ROOT}/${group}`;
  const exclude = `${WORK_DIR}/.git/info/exclude`;
  // .nixre/ is local scratch (attachments, screenshots) — hide it from git
  // status without touching the repo's .gitignore.
  try {
    const setup = `mkdir -p ${JSON.stringify(dir)} && grep -qxF '.nixre/' ${JSON.stringify(exclude)} 2>/dev/null || echo '.nixre/' >> ${JSON.stringify(exclude)}`;
    const { code, output } = await dockerExec(containerId, ['bash', '-lc', setup]);
    if (code !== 0) throw new Error(output || `exclude setup failed (exit ${code})`);
  } catch (err) {
    return { written: [], failed: files.map((f, i) => ({ index: i, name: f.name, error: err.message })), unavailable: false };
  }

  const written = [];
  const failed = [];
  const used = new Map();
  for (const [i, f] of files.entries()) {
    try {
      const stem = sanitizeAttachmentName(f.name, extForMime(f.mime)).replace(/\.[^.]+$/, '');
      const extMatch = sanitizeAttachmentName(f.name, extForMime(f.mime)).match(/\.([a-z0-9]+)$/i);
      const ext = extMatch ? `.${extMatch[1]}` : `.${extForMime(f.mime)}`;
      const n = (used.get(stem) || 0) + 1;
      used.set(stem, n);
      const rel = `${ATTACHMENTS_ROOT}/${group}/${stem}${n > 1 ? `-${n}` : ''}${ext}`;
      const target = `${WORK_DIR}/${rel}`;
      const b64 = Buffer.from(f.data).toString('base64');
      const script = `base64 -d > ${JSON.stringify(target)}`;
      const { code, output } = await dockerExec(containerId, ['bash', '-lc', script], { stdin: b64 });
      if (code !== 0) throw new Error(output || `write failed (exit ${code})`);
      written.push({ name: f.name || rel, path: rel });
    } catch (err) {
      failed.push({ index: i, name: f.name || `file-${i + 1}`, error: err.message });
    }
  }
  return { written, failed, unavailable: false };
}

/**
 * Read a file from the conversation's live sandbox workspace (uncommitted
 * files included — screenshots, build output). Returns a Buffer, or null when
 * there is no sandbox / the file is missing. Caps the transferred bytes at
 * maxBytes so a stray huge file cannot be piped into core whole.
 */
export async function readFileInSandbox({
  userId,
  conversationId,
  repoPath,
  space,
  repo,
  user,
  filePath,
  maxBytes,
}) {
  if (!(await isSandboxEnabled())) return null;
  if (!userId || !conversationId || !repoPath) return null;
  const key = sessionKey(userId, conversationId, repoPath);
  let containerId = null;
  try {
    const info = await docker.getContainer(containerName(key)).inspect();
    if (info.State.Status === 'running') {
      containerId = info.Id;
    } else {
      // Wake it. The resync's reset --hard only touches tracked files —
      // untracked files (screenshots) survive.
      containerId = await ensureRunningContainer(key, userId, conversationId, repoPath, space, repo, user);
    }
  } catch {
    return null; // no sandbox provisioned for this conversation
  }
  const rel = String(filePath || '').replace(/\\/g, '/');
  const target = `${WORK_DIR}/${rel}`;
  const b64Cap = Math.ceil((((maxBytes ?? 2 * 1024 * 1024) + 1) * 4) / 3) + 4;
  try {
    const { output, code } = await dockerExec(containerId, ['bash', '-lc', `base64 ${JSON.stringify(target)} | head -c ${b64Cap}`]);
    if (code !== 0) return null;
    return Buffer.from(String(output).replace(/\s+/g, ''), 'base64');
  } catch {
    return null;
  }
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
  } else {
    console.log('Agent sandbox not reachable yet — run_command falls back until Docker responds');
  }
  return ok;
}
