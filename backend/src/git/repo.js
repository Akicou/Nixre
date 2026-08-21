// Git CLI wrappers — all git plumbing goes through here.
//
// Strategy: shell out to the real git binary against bare repos on disk.
// Structured output (-z, --format with unit separators) everywhere so evil
// filenames can't break parsing. The repo root is /data/repos (REPOS_ROOT).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import crypto from 'node:crypto';

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
  await exec('git', ['init', '--bare', '--initial-branch', defaultBranch, dir]);
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

export async function repoExists(space, repo) {
  try {
    await git(repoDir(space, repo), ['rev-parse', '--is-bare-repository']);
    return true;
  } catch {
    return false;
  }
}

// Seed an initial commit with a README, authored by the creator. Done via a
// temporary non-bare clone so commit machinery (identities, hooks) works.
export async function seedReadme(space, repo, { authorName, authorEmail, description }) {
  const dir = repoDir(space, repo);
  const tmp = `${dir}-seed-${crypto.randomBytes(4).toString('hex')}`;
  const { writeFile, mkdir, rm } = await import('node:fs/promises');
  try {
    await exec('git', ['clone', dir, tmp]);
    await writeFile(`${tmp}/README.md`, `# ${repo}\n\n${description || ''}\n`, 'utf8');
    const identity = ['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`];
    await exec('git', ['-C', tmp, ...identity, 'add', 'README.md']);
    await exec('git', ['-C', tmp, ...identity, 'commit', '-m', 'Initial commit', `--author=${authorName} <${authorEmail}>`]);
    await exec('git', ['-C', tmp, 'push', 'origin', 'HEAD']);
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

// Commit history at a ref, newest first, paginated.
export async function listCommits(space, repo, ref, { page = 1, limit = 25 } = {}) {
  const dir = repoDir(space, repo);
  const skip = (page - 1) * limit;
  const fmt = ['%H', '%h', '%s', '%b', '%an', '%ae', '%aI', '%cI'].join(US);
  const out = await git(dir, [
    'log', `--format=${fmt}%n${US}${US}`, '--no-color', `--skip=${skip}`, `--max-count=${limit}`, ref,
  ]);
  const commits = [];
  for (const record of out.split(`${US}${US}\n`)) {
    if (!record.trim()) continue;
    const [sha, shortSha, subject, body, name, email, authored, committed] = record.trim().split(US);
    commits.push({
      sha,
      short_sha: shortSha,
      title: subject,
      message: body ? `${subject}\n\n${body}` : subject,
      author: { identity: email, name, email, when: authored },
      committer: { identity: email, name, email, when: committed },
    });
  }
  return commits;
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
