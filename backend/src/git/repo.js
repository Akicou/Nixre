// Git CLI wrappers — all git plumbing goes through here.
//
// Strategy: shell out to the real git binary against bare repos on disk.
// Structured output (-z, --format with unit separators) everywhere so evil
// filenames can't break parsing. The repo root is /data/repos (REPOS_ROOT).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const exec = promisify(execFile);

export const REPOS_ROOT = process.env.REPOS_ROOT || '/data/repos';

// --- safety -----------------------------------------------------------------

// A repo ref is `space/repo`; both segments restricted to safe charset so
// the value can never escape REPOS_ROOT (no .., no /, no absolute paths).
export function validRefSegment(segment) {
  return /^[a-z0-9][a-z0-9-_.]{0,62}$/i.test(segment);
}

export function repoDir(space, repo) {
  if (!validRefSegment(space) || !validRefSegment(repo)) {
    throw new Error('Invalid repo ref');
  }
  return path.join(REPOS_ROOT, space, `${repo}.git`);
}

async function git(repoPath, args, opts = {}) {
  const { stdout } = await exec('git', ['-C', repoPath, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  return stdout;
}

// --- repository lifecycle ------------------------------------------------------

const POST_RECEIVE_HOOK = [
  '#!/bin/sh',
  '[ -f /srv/nixre-env.sh ] && . /srv/nixre-env.sh',
  'CORE="${CORE_URL:-http://nixre-core:3002}"',
  'TOKEN="${INTERNAL_TOKEN:-}"',
  'SPACE=""; REPO=""',
  'case "$PWD" in */repos/*/*.git) SPACE=$(basename $(dirname "$PWD")); REPO=$(basename "$PWD" .git);; esac',
  'while read old new ref; do',
  '  case "$ref" in refs/heads/*) BRANCH="${ref#refs/heads/}";',
  '    curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\',
  '      -d "{\\"space\\":\\"$SPACE\\",\\"repo\\":\\"$REPO\\",\\"branch\\":\\"$BRANCH\\",\\"before\\":\\"$old\\",\\"after\\":\\"$new\\",\\"pusher\\":\\"webhook\\"}" \\',
  '      "$CORE/api/v1/internal/push-event" >/dev/null 2>&1 || true;;',
  '  esac',
  'done',
  'exit 0',
].join('\n');

// Write the webhook post-receive hook into a bare repo. Idempotent.
export async function installPostReceiveHook(dir) {
  const { writeFile, mkdir, chmod } = await import('node:fs/promises');
  await mkdir(`${dir}/hooks`, { recursive: true });
  await writeFile(`${dir}/hooks/post-receive`, POST_RECEIVE_HOOK, 'utf8');
  await chmod(`${dir}/hooks/post-receive`, 0o775);
}

export async function initBareRepo(space, repo, { defaultBranch = 'main' } = {}) {
  const dir = repoDir(space, repo);
  try {
    await mkdir(path.dirname(dir), { recursive: true });
  } catch (err) {
    const code = err && err.code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(
        `${path.dirname(dir)} is not writable by nixre-core. The /data/repos volume must be owned by uid 1000.`,
      );
    }
    throw err;
  }
  // Re-creating a repo (UI retry after a 502, leftover disk from a failed
  // insert) must not throw — git init on an existing dir is fine, but a
  // non-git leftover or a missing parent used to 502 the HTTP request.
  if (!(await repoExists(space, repo))) {
    await exec('git', ['init', '--bare', '--initial-branch', defaultBranch, dir]);
  }
  // Allow default-branch push to an empty repo over HTTP.
  await git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`]);
  await git(dir, ['config', 'http.receivepack', 'true']);
  // post-receive hook: notify core so repo webhooks fire. Works in both the
  // core container (env vars) and the ssh container (/srv/nixre-env.sh).
  await installPostReceiveHook(dir);
  // Group/other read so the nixre-ssh container's git user can serve it.
  await exec('chmod', ['-R', 'a+rX', dir]).catch(() => {});
  return dir;
}

// Repair pass for repos created before the hook existed: (re)install the
// post-receive hook on every bare repo under REPOS_ROOT.
export async function repairAllHooks() {
  const { readdir } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  let fixed = 0;
  for (const space of await readdir(REPOS_ROOT).catch(() => [])) {
    for (const entry of await readdir(`${REPOS_ROOT}/${space}`).catch(() => [])) {
      const dir = `${REPOS_ROOT}/${space}/${entry}`;
      if (!entry.endsWith('.git') || !existsSync(`${dir}/HEAD`)) continue;
      await installPostReceiveHook(dir);
      fixed++;
    }
  }
  return fixed;
}

export async function removeBareRepo(space, repo) {
  const dir = repoDir(space, repo);
  await exec('rm', ['-rf', dir]);
}

export async function moveBareRepo(fromSpace, fromRepo, toSpace, toRepo) {
  const src = repoDir(fromSpace, fromRepo);
  const dest = repoDir(toSpace, toRepo);
  if (src === dest) return dest;
  if (await repoExists(toSpace, toRepo)) {
    throw new Error('Destination repository already exists on disk');
  }
  const { rename } = await import('node:fs/promises');
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(src, dest);
  await installPostReceiveHook(dest);
  await exec('chmod', ['-R', 'a+rX', dest]).catch(() => {});
  return dest;
}

export async function repoExists(space, repo) {
  try {
    await git(repoDir(space, repo), ['rev-parse', '--is-bare-repository']);
    return true;
  } catch {
    return false;
  }
}

/** True when the bare repo has at least one commit (HEAD resolves). */
export async function hasHead(space, repo) {
  try {
    await git(repoDir(space, repo), ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

// Seed an initial commit with a README, authored by the creator. Done via a
// temporary non-bare clone so commit machinery (identities, hooks) works.
export async function seedReadme(space, repo, { authorName, authorEmail, description, content }) {
  const dir = repoDir(space, repo);
  const tmp = `${dir}-seed-${crypto.randomBytes(4).toString('hex')}`;
  const { writeFile, mkdir, rm } = await import('node:fs/promises');
  try {
    await exec('git', ['clone', dir, tmp]);
    const readme =
      content && content.trim() ? content : `# ${repo}\n\n${description || ''}\n`;
    await writeFile(`${tmp}/README.md`, readme, 'utf8');
    const identity = ['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`];
    await exec('git', ['-C', tmp, ...identity, 'add', 'README.md']);
    await exec('git', ['-C', tmp, ...identity, 'commit', '-m', 'Initial commit', `--author=${authorName} <${authorEmail}>`]);
    await exec('git', ['-C', tmp, 'push', 'origin', 'HEAD']);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

const MAX_WEB_FILE_BYTES = 1024 * 1024;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Repo-relative path: no absolute, no `.` / `..` segments, no NUL.
export function validGitPath(filePath) {
  const s = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!s || s.length > 512 || s.includes('\0')) return null;
  const parts = s.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) return null;
  return s;
}

// Lightweight git-check-ref-format for branch names we create or check out.
export function validBranchName(name) {
  const s = String(name || '').trim();
  if (!s || s.length > 200 || s === 'HEAD') return null;
  if (s.startsWith('/') || s.endsWith('/') || s.includes('//') || s.includes('..')) return null;
  if (s.endsWith('.lock') || /[\s\\~\^:?*\[\@\{]/.test(s) || s.includes('\0')) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(s)) return null;
  return s;
}

function resolveUnder(root, rel) {
  const abs = path.resolve(root, ...rel.split('/'));
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

// Web UI commit: temp clone, write text files, commit as the session user, push.
export async function commitFiles(space, repo, {
  branch,
  newBranch,
  message,
  files,
  baseSha,
  authorName,
  authorEmail,
}) {
  const src = validBranchName(branch);
  if (!src) throw httpError(400, 'Invalid branch');
  const dest = newBranch ? validBranchName(newBranch) : null;
  if (newBranch && !dest) throw httpError(400, 'Invalid new branch name');
  const msg = String(message || '').trim();
  if (!msg) throw httpError(400, 'Commit message is required');
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) throw httpError(400, 'No files to commit');

  const dir = repoDir(space, repo);
  const tmp = `${dir}-web-${crypto.randomBytes(4).toString('hex')}`;
  const { writeFile, mkdir, rm, access } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const identity = ['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`];

  try {
    await exec('git', ['clone', '--branch', src, '--single-branch', dir, tmp]);
    if (baseSha) {
      const { stdout } = await exec('git', ['-C', tmp, 'rev-parse', 'HEAD']);
      if (stdout.trim() !== String(baseSha).trim()) {
        throw httpError(409, 'The branch has new commits. Reload and try again.');
      }
    }
    if (dest) {
      if (await branchExists(space, repo, dest)) {
        throw httpError(409, `Branch '${dest}' already exists`);
      }
      await exec('git', ['-C', tmp, 'checkout', '-b', dest]);
    }

    for (const f of list) {
      const rel = validGitPath(f.path);
      if (!rel) throw httpError(400, 'Invalid file path');
      const action = f.action === 'create' ? 'create' : 'update';
      const content = String(f.content ?? '');
      if (content.includes('\0')) {
        throw httpError(400, 'Binary files cannot be edited in the web UI');
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_WEB_FILE_BYTES) {
        throw httpError(400, 'File is too large to commit in the web UI (1 MB max)');
      }
      const abs = resolveUnder(tmp, rel);
      if (!abs) throw httpError(400, 'Invalid file path');
      let exists = false;
      try {
        await access(abs, constants.F_OK);
        exists = true;
      } catch { /* missing */ }
      if (action === 'create' && exists) throw httpError(409, 'File already exists');
      if (action === 'update' && !exists) throw httpError(404, 'File not found');
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      await exec('git', ['-C', tmp, 'add', '--', rel]);
    }

    try {
      await exec('git', [
        '-C', tmp, ...identity, 'commit', '-m', msg,
        `--author=${authorName} <${authorEmail}>`,
      ]);
    } catch (err) {
      const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
      if (/nothing to commit/i.test(out)) throw httpError(400, 'No changes to commit');
      throw err;
    }
    const target = dest || src;
    await exec('git', ['-C', tmp, 'push', 'origin', `HEAD:refs/heads/${target}`]);
    const { stdout } = await exec('git', ['-C', tmp, 'rev-parse', 'HEAD']);
    return { sha: stdout.trim(), branch: target };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// --- reads --------------------------------------------------------------------

// Tree listing at a ref + path. Returns [{ type: 'file'|'dir', name, size }]
export async function listTree(space, repo, ref, dirPath = '') {
  const at = dirPath ? `${ref}:${dirPath}` : `${ref}:`;
  const out = await git(repoDir(space, repo), ['ls-tree', '-l', '-z', '--full-name', at]);
  const entries = [];
  for (const record of out.split('\0')) {
    if (!record) continue;
    // <mode> <type> <sha> <size>\t<name>  (size right-aligned, '-' for trees)
    const m = record.match(/^(\d+) (\w+) ([0-9a-f]+)\s+(\d+|-)\t(.*)$/);
    if (!m) continue;
    entries.push({
      type: m[2] === 'tree' ? 'dir' : 'file',
      name: m[5],
      size: m[4] === '-' ? undefined : Number(m[4]),
      sha: m[3],
    });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return entries;
}

// Blob content + size. Returns raw Buffer (binary-safe).
export async function readBlob(space, repo, ref, filePath) {
  const dir = repoDir(space, repo);
  const { stdout } = await exec('git', ['-C', dir, 'cat-file', '-p', `${ref}:${filePath}`], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'buffer',
  });
  const sizeOut = await git(dir, ['cat-file', '-s', `${ref}:${filePath}`]);
  return { content: stdout, size: Number(sizeOut.trim()) };
}

const US = '\u001f'; // unit separator for --format fields

// Commit history at a ref, newest first, paginated. When `path` is given the
// log is narrowed to commits touching that file/folder (GitHub "History").
// `follow` follows a single path across renames.
export async function listCommits(space, repo, ref, { page = 1, limit = 25, path, follow = false } = {}) {
  const dir = repoDir(space, repo);
  const skip = (page - 1) * limit;
  const fmt = ['%H', '%h', '%s', '%b', '%an', '%ae', '%aI', '%cI'].join(US);
  const args = [
    'log', `--format=${fmt}%n${US}${US}`, '--no-color', `--skip=${skip}`, `--max-count=${limit}`,
  ];
  if (follow) args.push('--follow');
  args.push(ref);
  if (path) args.push('--', path);
  const out = await git(dir, args);
  const commits = [];
  for (const record of out.split(`${US}${US}\n`)) {
    if (!record.trim()) continue;
    const [sha, shortSha, subject, body, name, email, authored, committed] = record.trim().split(US);
    commits.push({
      sha,
      short_sha: shortSha,
      title: subject,
      message: body ? `${subject}\n\n${body}` : subject,
      author: { identity: { name, email }, name, email, when: authored },
      committer: { identity: { name, email }, name, email, when: committed },
    });
  }
  return commits;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Author dates only (`%aI`), for contribution heatmaps. Empty / unreadable
// repos return []. `--all` so activity on any branch counts.
export async function commitDates(space, repo, { since, until, authorEmail } = {}) {
  const dir = repoDir(space, repo);
  const args = ['log', '--all', '--format=%aI'];
  if (since) args.push(`--since=${since}`);
  if (until) args.push(`--until=${until}`);
  if (authorEmail) args.push(`--author=${escapeRegExp(authorEmail)}`);
  try {
    const out = await git(dir, args);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Parse one commit record for `show <ref>` (used by getCommit).
async function readSingleCommit(space, repo, ref) {
  const dir = repoDir(space, repo);
  const fmt = ['%H', '%h', '%s', '%b', '%an', '%ae', '%aI', '%cI'].join(US);
  const out = await git(dir, ['show', '-s', `--format=${fmt}%n${US}${US}`, ref]);
  const record = out.split(`${US}${US}\n`)[0];
  if (!record || !record.trim()) throw new Error('no commit');
  const [sha, shortSha, subject, body, name, email, authored, committed] = record.trim().split(US);
  return {
    sha,
    short_sha: shortSha,
    title: subject,
    message: body ? `${subject}\n\n${body}` : subject,
    author: { identity: { name, email }, name, email, when: authored },
    committer: { identity: { name, email }, name, email, when: committed },
  };
}

// Single commit + per-file stats. Used by the commit-detail view
// (files changed, additions/deletions totals). `ref` may be a full/short sha.
export async function getCommit(space, repo, ref) {
  const commit = await readSingleCommit(space, repo, ref);
  const dir = repoDir(space, repo);
  const numstat = await git(dir, ['show', '--numstat', '--format=', ref]);
  const files = [];
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    if (!line) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    const add = m[1] === '-' ? 0 : Number(m[1]);
    const del = m[2] === '-' ? 0 : Number(m[2]);
    additions += add;
    deletions += del;
    files.push({ path: m[3], additions: add, deletions: del, status: 'MODIFIED' });
  }
  return { commit, stats: { additions, deletions, changes: additions + deletions }, files };
}

// Branch list with ahead/behind vs the default branch.
export async function listBranches(space, repo, defaultBranch) {
  const dir = repoDir(space, repo);
  const fmt = ['%(refname:short)', '%(objectname)', '%(committerdate:iso8601)', '%(authorname)', '%(subject)'].join(US);
  const out = await git(dir, ['for-each-ref', `--format=${fmt}`, 'refs/heads']);
  const branches = [];
  for (const record of out.split('\n').filter(Boolean)) {
    const [name, sha, date, authorName, subject] = record.split(US);
    let ahead = 0;
    let behind = 0;
    if (name !== defaultBranch) {
      try {
        const counts = await git(dir, ['rev-list', '--left-right', '--count', `${name}...${defaultBranch}`]);
        const [a, b] = counts.trim().split(/\s+/).map(Number);
        ahead = a || 0;
        behind = b || 0;
      } catch {
        // default branch may not exist yet (empty repo)
      }
    }
    branches.push({ name, sha, date, authorName, subject, ahead, behind });
  }
  return branches;
}

export async function resolveDefaultBranch(space, repo, fallback = 'main') {
  const dir = repoDir(space, repo);
  try {
    const out = await git(dir, ['symbolic-ref', '--short', 'HEAD']);
    return out.trim() || fallback;
  } catch {
    return fallback;
  }
}

// --- pull request support (phase 3) --------------------------------------------

export async function mergeBase(space, repo, target, source) {
  const out = await git(repoDir(space, repo), ['merge-base', target, source]);
  return out.trim();
}

export async function branchExists(space, repo, branch) {
  try {
    await git(repoDir(space, repo), ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

// Per-file stats + unified patch between two refs (three-dot semantics).
// Returns [{ path, old_path, status, additions, deletions, patch }] where
// patch is the raw unified diff for that file (base64-encoded by the caller
// to match the UI's wire format).
export async function diffRefs(space, repo, target, source) {
  const base = await mergeBase(space, repo, target, source);
  const dir = repoDir(space, repo);
  // numstat: <adds> <dels> <path> (binary -> "- - path")
  const numstat = await git(dir, ['diff', '--numstat', '-z', `${base}...${source}`]);
  const stats = [];
  let i = 0;
  const parts = numstat.split('\0');
  while (i < parts.length) {
    if (!parts[i]) {
      i++;
      continue;
    }
    const m = parts[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (m) {
      stats.push({ additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]), path: m[3] });
      i++;
    } else {
      // rename/copy entries: path then the real path follows in the next slot
      const a = parts[i];
      const b = parts[i + 1] ?? '';
      stats.push({ additions: 0, deletions: 0, path: b, oldPath: a });
      i += 2;
    }
  }

  // One combined patch; split per-file on `diff --git` boundaries.
  const patch = await git(dir, ['diff', '--find-renames', `${base}...${source}`]);
  const patches = {};
  let current = null;
  const lines = patch.split('\n');
  const buf = [];
  const flush = () => {
    if (current) patches[current] = buf.join('\n');
    buf.length = 0;
  };
  for (const line of lines) {
    const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (m) {
      flush();
      current = m[2];
    }
    if (current) buf.push(line);
  }
  flush();

  return stats.map(s => ({
    path: s.path,
    old_path: s.oldPath ?? s.path,
    status: 'MODIFIED',
    additions: s.additions,
    deletions: s.deletions,
    changes: s.additions + s.deletions,
    patch: patches[s.path] ?? '',
    is_binary: s.additions === 0 && s.deletions === 0 && !patches[s.path],
    is_submodule: false,
  }));
}

// Merge source into target in a temp clone and push the result.
// method: 'merge' (merge commit) | 'squash' (single commit). Returns the
// resulting target sha.
export async function mergeBranches(space, repo, target, source, method, { authorName, authorEmail }) {
  const dir = repoDir(space, repo);
  const tmp = `${dir}-merge-${crypto.randomBytes(4).toString('hex')}`;
  const { rm } = await import('node:fs/promises');
  const identity = ['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`];
  try {
    await exec('git', ['clone', dir, tmp]);
    await exec('git', ['-C', tmp, 'fetch', 'origin', target, source]);
    await exec('git', ['-C', tmp, 'checkout', '-B', target, `origin/${target}`]);
    if (method === 'squash') {
      await exec('git', ['-C', tmp, ...identity, 'merge', '--squash', `origin/${source}`]);
      await exec('git', ['-C', tmp, ...identity, 'commit', '-m', `Squash merge ${source} into ${target}`]);
    } else {
      await exec('git', ['-C', tmp, ...identity, 'merge', '--no-ff', '-m', `Merge branch '${source}' into ${target}`, `origin/${source}`]);
    }
    await exec('git', ['-C', tmp, 'push', 'origin', target]);
    const { stdout } = await exec('git', ['-C', tmp, 'rev-parse', target]);
    return stdout.trim();
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
