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

export async function initBareRepo(space, repo, { defaultBranch = 'main', readme = false } = {}) {
  const dir = repoDir(space, repo);
  await exec('git', ['init', '--bare', '--initial-branch', defaultBranch, dir]);
  // Allow default-branch push to an empty repo over HTTP.
  await git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`]);
  await git(dir, ['config', 'http.receivepack', 'true']);
  return dir;
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
