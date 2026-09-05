// Workspace targets — what a conversation is bound to.
//
// repoPath conventions:
//   "space/repo"          → Nixre hosted repository (bare repo under REPOS_ROOT)
//   "github/owner/repo"   → github.com repository, mirrored on demand under
//                           REPOS_ROOT/.mirrors/github/<owner>/<repo>.git so
//                           every git-based tool (list_files, grep, sandbox
//                           clone) keeps working unchanged. Pushes go straight
//                           to github.com with the user's stored PAT.
//   "unrestricted"        → no attached repo; the sandbox is a free-form
//                           scratch workspace.
//
// The mirror lives inside REPOS_ROOT so the existing read-only /data/repos
// bind mount reaches it from the sandbox container without new mounts.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { REPOS_ROOT } from '../git/repo.js';
import { getDecryptedSecret } from './userSecrets.js';

const exec = promisify(execFile);

export const UNRESTRICTED_PATH = 'unrestricted';
export const GITHUB_SPACE = 'github';
export const GITHUB_MIRROR_ROOT = path.join(REPOS_ROOT, '.mirrors', GITHUB_SPACE);
const GITHUB_API_BASE = process.env.GITHUB_API_URL || 'https://api.github.com';

const NIXRE_SEGMENT = /^[a-z0-9][a-z0-9-_.]{0,62}$/i;
// GitHub owners/repos may contain dots and hyphens but never start with one.
const GITHUB_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const CLONE_TIMEOUT_MS = 300_000;
const GIT_TIMEOUT_MS = 120_000;
const MIRROR_REFRESH_TTL_MS = Number(process.env.GITHUB_MIRROR_TTL_MS || 10 * 60 * 1000);

// --- parsing -----------------------------------------------------------------

/**
 * Parse a conversation repoPath into a workspace descriptor (pure, no IO).
 * Returns { kind, space, repo, owner?, fullName?, repoPath } or { kind: 'invalid' }.
 */
export function parseWorkspacePath(repoPath) {
  const p = String(repoPath || '').trim();
  if (!p || p === UNRESTRICTED_PATH) {
    return { kind: 'unrestricted', space: '', repo: '', repoPath: UNRESTRICTED_PATH };
  }
  const parts = p.split('/').filter(Boolean);
  if (parts.length === 2 && NIXRE_SEGMENT.test(parts[0]) && NIXRE_SEGMENT.test(parts[1])) {
    return { kind: 'nixre', space: parts[0], repo: parts[1], repoPath: p };
  }
  if (
    parts.length === 3 &&
    parts[0] === GITHUB_SPACE &&
    GITHUB_SEGMENT.test(parts[1]) &&
    GITHUB_SEGMENT.test(parts[2])
  ) {
    return { kind: 'github', space: parts[1], repo: parts[2], owner: parts[1], fullName: `${parts[1]}/${parts[2]}`, repoPath: p };
  }
  return { kind: 'invalid', repoPath: p };
}

/**
 * Local git dir for a parsed workspace, safe to hand to `git -C`.
 * Returns null for unrestricted (no attached repo).
 */
export function workspaceGitDir(ws) {
  if (!ws || ws.kind === 'unrestricted') return null;
  if (ws.kind === 'nixre') return path.join(REPOS_ROOT, ws.space, `${ws.repo}.git`);
  if (ws.kind === 'github') return path.join(GITHUB_MIRROR_ROOT, ws.owner, `${ws.repo}.git`);
  return null;
}

// --- github plumbing -----------------------------------------------------------

/**
 * Run git with an inline credential helper that sources the PAT from the
 * process env of this invocation only. The token never lands in argv,
 * mirrors' config, or any persisted file.
 */
async function gitWithPat(dir, args, token, timeoutMs = GIT_TIMEOUT_MS) {
  const helper = '!f(){ printf "username=x-access-token\\npassword=%s\\n" "$NIXRE_GH_PAT"; }; f';
  return exec(
    'git',
    ['-C', dir, '-c', `credential.helper=${helper}`, ...args],
    {
      env: { ...process.env, NIXRE_GH_PAT: token, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    },
  );
}

function friendlyGithubCloneError(stderr) {
  const s = String(stderr || '');
  if (/Authentication failed|Invalid username or password|403/.test(s)) {
    return 'GitHub rejected the PAT or it lacks access to this repository.';
  }
  if (/not found|404/i.test(s)) {
    return 'Repository not found on github.com (private repos need the PAT to include it).';
  }
  if (/Could not resolve host|Connection timed out|Failed to connect/i.test(s)) {
    return 'Could not reach github.com from the server.';
  }
  return `GitHub clone failed: ${s.split('\n').slice(-3).join(' ').trim().slice(0, 300)}`;
}

/** Coalesce concurrent provisions of the same mirror. */
const pendingMirrors = new Map();

function markSynced(dir) {
  // Freshness marker: FETCH_HEAD only updates on fetch; touch our own file so
  // clones that never fetched still count as fresh.
  fs.utimes(path.join(dir, '.nixre-sync'), new Date(), new Date()).catch(() => {});
}

async function mirrorLastSyncMs(dir) {
  try {
    const st = await fs.stat(path.join(dir, '.nixre-sync'));
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

async function fetchMirror(owner, repo, dir, token) {
  await gitWithPat(
    dir,
    ['fetch', '--prune', '--quiet', 'origin', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'],
    token,
  );
  await gitWithPat(dir, ['remote', 'set-head', 'origin', '--auto'], token).catch(() => {});
  markSynced(dir);
}

/**
 * Clone-on-demand a bare mirror of github.com/owner/repo into
 * .mirrors/github/<owner>/<repo>.git. Throws with a user-facing message when
 * the PAT is missing or the clone fails.
 */
export async function ensureGithubMirror(userId, owner, repo, { waitTimeoutMs = CLONE_TIMEOUT_MS } = {}) {
  const token = userId ? await getDecryptedSecret(userId, 'github') : null;
  if (!token) {
    throw Object.assign(
      new Error('No GitHub personal access token configured. Add one in Settings → GitHub to work on github.com repositories.'),
      { status: 400 },
    );
  }

  const url = `${process.env.GITHUB_URL || 'https://github.com'}/${owner}/${repo}.git`;
  const dir = path.join(GITHUB_MIRROR_ROOT, owner, `${repo}.git`);
  const exists = await fs.access(dir).then(() => true, () => false);

  if (!exists) {
    let pending = pendingMirrors.get(dir);
    if (!pending) {
      pending = (async () => {
        await fs.mkdir(path.dirname(dir), { recursive: true });
        const helper = '!f(){ printf "username=x-access-token\\npassword=%s\\n" "$NIXRE_GH_PAT"; }; f';
        try {
          await exec('git', ['-c', `credential.helper=${helper}`, 'clone', '--bare', '--quiet', url, dir], {
            env: { ...process.env, NIXRE_GH_PAT: token, GIT_TERMINAL_PROMPT: '0' },
            maxBuffer: 64 * 1024 * 1024,
            timeout: CLONE_TIMEOUT_MS,
          });
        } catch (err) {
          // Remove half-provisioned dirs so retries start clean.
          await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
          throw Object.assign(new Error(friendlyGithubCloneError(err.stderr)), { status: 400 });
        }
        // World-readable so the nixre-ssh container and the ro-mounted sandbox can read it.
        await exec('chmod', ['-R', 'a+rX', dir]).catch(() => {});
        markSynced(dir);
        return dir;
      })().finally(() => pendingMirrors.delete(dir));
      pendingMirrors.set(dir, pending);
    }
    const finished = Promise.race([
      pending,
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error(`Cloning ${owner}/${repo} is still running (${waitTimeoutMs / 1000}s wait exceeded)`)), { status: 504 }), waitTimeoutMs),
      ),
    ]);
    return finished;
  }

  // Existing mirror: serve it immediately, refresh in the background when stale.
  const last = await mirrorLastSyncMs(dir);
  if (Date.now() - last > MIRROR_REFRESH_TTL_MS) {
    void fetchMirror(owner, repo, dir, token).catch(err => {
      console.warn(`[workspaces] mirror refresh ${owner}/${repo}:`, err.message);
    });
  }
  return dir;
}

/**
 * Resolve a repoPath into everything tools need. GitHub resolution hits the
 * network on first use; failures carry `.status` for HTTP mapping.
 */
export async function resolveWorkspace(pool, userId, repoPath) {
  const ws = parseWorkspacePath(repoPath);
  if (ws.kind === 'invalid') {
    throw Object.assign(new Error(`Invalid workspace target '${ws.repoPath}'`), { status: 400 });
  }
  if (ws.kind === 'unrestricted') {
    ws.dir = null;
    return ws;
  }
  // Attach the git dir the read/clone tools expect (see lib/agentTools.js
  // contract: context.workspace.dir). For a github target this must come
  // AFTER the mirror is provisioned so the dir exists. Unrestricted has no
  // repo, so dir is null.
  if (ws.kind === 'github') {
    await ensureGithubMirror(userId, ws.owner, ws.repo);
  }
  ws.dir = workspaceGitDir(ws);
  return ws;
}

// --- prompt block --------------------------------------------------------------

/**
 * Per-target guidance appended as a <workspace> system block each turn. The
 * four role prompts stay mode-generic; source-specific rules live here.
 */
export function workspaceContextBlock(ws) {
  if (!ws) return '';
  if (ws.kind === 'nixre') {
    return `<workspace>
Active target: ${ws.space}/${ws.repo} — a repository hosted in this Nixre forge.
Your sandbox at /workspace/repo is a working clone of it (git identity is already configured). Committing and \`git push\` publishes branches back to the forge over authenticated HTTP. list_files / read_file / search_code / show_images operate against the hosted HEAD; show_images also reads files you saved in the sandbox (screenshots included).
</workspace>`;
  }
  if (ws.kind === 'github') {
    return `<workspace>
Active target: ${ws.fullName} — a repository on github.com. It is mirrored locally for reading, and your sandbox at /workspace/repo is a full working clone.
- \`git push origin <branch>\` publishes straight to github.com using the owner's stored credentials — never print, log or exfiltrate them ($GITHUB_TOKEN stays in the container).
- Prefer feature branches over pushing main; link the PR (https://github.com/${ws.fullName}/compare/<base>...<branch>).
- Files added by upstream since your turn started may not be visible until the next refresh; if something looks stale, \`git fetch origin\` first.
- show_images also reads files you saved in the sandbox (screenshots included), not only the mirror's HEAD.
</workspace>`;
  }
  return `<workspace>
Unrestricted mode — no repository is attached.
/workspace/repo is your persistent scratch workspace (its volume survives idle restarts). You have no hosted repo bound to this conversation, so do not ask which repo to work on: bootstrap whatever the task needs — git init a project, clone public/private repositories over HTTPS ($GITHUB_TOKEN authenticates private ones and github pushes), scaffold applications, install packages, run builds/tests/servers briefly.
Read tools (list_files, read_file, search_code, show_images) are unavailable without an attached repository — inspect files from your workspace via run_command instead.
Stay transparent about destructive actions outside your own workspace; there is no undo there.
</workspace>`;
}
