// Agent tools — repo operations the assistant can invoke.
//
// Read-only tools (list_files, read_file, search_code, show_images) work
// against the bare repo on disk via git plumbing and are safe to expose to
// any authenticated user with repo access. run_command clones the repo to a
// temp dir and execs a shell command there — gated behind the caller's
// per-repo access profile (canRunBash / canRunTests), with hard timeouts and
// output caps. web_search queries the web and is gated behind canSearchWeb.
// allowedPaths / blockedPaths restrict which repo files the read tools may
// touch.
//
// Every tool returns { output } or throws; the route maps errors to text.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { repoDir } from '../git/repo.js';
import { webSearch } from './webSearch.js';

const exec = promisify(execFile);

const MAX_LIST = 500;
const MAX_FILE_BYTES = 48 * 1024;
const MAX_GREP_MATCHES = 60;
const MAX_CMD_MS = 120_000;
const MAX_CMD_BYTES = 32 * 1024;

export const TOOL_SCHEMAS = [
  {
    name: 'list_files',
    description: 'List all file paths in the repository (default branch).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_file',
    description: 'Read a file from the repository (default branch). Returns its text content.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Repo-relative file path' } },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description: 'Regex search across all tracked files. Returns matching lines as path:line: text.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Regular expression to search for' } },
      required: ['query'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in a fresh clone of the repository (e.g. "npm test", "make lint"). Use for tests, builds and inspection. Output is truncated.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command to run inside the repo clone' } },
      required: ['command'],
    },
  },
  {
    name: 'show_images',
    description:
      'Display one or more images from the repository in the chat so the user can see them. Pass repo-relative paths (png/jpg/gif/webp). Use when a screenshot, diagram or asset would help the user.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repo-relative image paths to display',
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web for up-to-date documentation, APIs and fixes. Returns a list of results with title, url and a short snippet. Use when the answer is not in the repository.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        max_results: { type: 'number', description: 'Maximum results (default 8, max 20)' },
      },
      required: ['query'],
    },
  },
];

// --- safety -----------------------------------------------------------------

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-_.]{0,62}$/i;

function assertRepo(space, repo) {
  if (!SAFE_SEGMENT.test(space || '') || !SAFE_SEGMENT.test(repo || '')) {
    throw new Error('Invalid repo ref');
  }
}

// Repo-relative paths must be relative, forward-slash, and contain no
// traversal or drive tricks before they ever touch git.
function assertSafePath(p) {
  const s = String(p || '');
  if (!s || s.length > 512) throw new Error('Invalid path');
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) throw new Error('Invalid path');
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new Error('Invalid path');
  }
  return s;
}

async function git(dir, args, opts = {}) {
  const { stdout } = await exec('git', ['-C', dir, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    ...opts,
  });
  return stdout;
}

// --- path allow/block rules ---------------------------------------------------

// One glob per line (from the repo access profile). `*` matches within a
// segment, `**` crosses `/`, `?` matches a single non-slash char.
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // '**/' matches zero or more dirs
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function pathRules(permissions) {
  const lines = key =>
    String(permissions?.[key] || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
  return {
    allowed: lines('allowedPaths').map(globToRegex),
    blocked: lines('blockedPaths').map(globToRegex),
  };
}

function pathAllowed(p, rules) {
  if (rules.blocked.some(re => re.test(p))) return false;
  if (rules.allowed.length > 0 && !rules.allowed.some(re => re.test(p))) return false;
  return true;
}

// --- read-only tools ----------------------------------------------------------

export async function listFiles(space, repo, args, permissions = {}) {
  assertRepo(space, repo);
  const out = await git(repoDir(space, repo), ['ls-tree', '-r', '--name-only', 'HEAD']);
  const rules = pathRules(permissions);
  const files = out.split('\n').filter(Boolean).filter(p => pathAllowed(p, rules));
  const head = files.slice(0, MAX_LIST);
  const suffix = files.length > MAX_LIST ? `\n… ${files.length - MAX_LIST} more (truncated)` : '';
  return { output: `${files.length} files\n${head.join('\n')}${suffix}` };
}

export async function readFile(space, repo, args, permissions = {}) {
  assertRepo(space, repo);
  const p = assertSafePath(args?.path);
  const rules = pathRules(permissions);
  if (!pathAllowed(p, rules)) throw new Error(`Path '${p}' is outside the allowed paths for this repo`);
  const dir = repoDir(space, repo);
  // Reject symlinks / submodules cheaply by checking the tracked mode.
  const ls = await git(dir, ['ls-tree', 'HEAD', '--', p]);
  if (/^160000 /.test(ls)) throw new Error('Refusing to read submodule');
  const { stdout } = await exec('git', ['-C', dir, 'show', `HEAD:${p}`], {
    maxBuffer: MAX_FILE_BYTES + 1024,
    timeout: 15_000,
  });
  const buf = Buffer.from(stdout, 'binary');
  const text = buf.length > MAX_FILE_BYTES
    ? `${buf.subarray(0, MAX_FILE_BYTES).toString('utf8')}\n… (truncated at ${MAX_FILE_BYTES} bytes)`
    : buf.toString('utf8');
  return { output: text };
}

export async function searchCode(space, repo, args, permissions = {}) {
  assertRepo(space, repo);
  const query = String(args?.query || '');
  if (!query || query.length > 256) throw new Error('Invalid search query');
  const dir = repoDir(space, repo);
  let out;
  try {
    out = await git(dir, ['grep', '-n', '-I', '-E', '-e', query, 'HEAD']);
  } catch (err) {
    if (err.code === 1) return { output: 'No matches.' }; // git grep: 1 = no matches
    if (err.code === 2) {
      // Bad regex — fall back to a literal search so the model still gets data.
      try {
        out = await git(dir, ['grep', '-n', '-I', '-F', '-e', query, 'HEAD']);
      } catch (err2) {
        if (err2.code === 1) return { output: 'No matches.' };
        throw err2;
      }
    } else {
      throw err;
    }
  }
  const rules = pathRules(permissions);
  const lines = out
    .split('\n')
    .filter(Boolean)
    .filter(line => pathAllowed(line.slice(0, line.indexOf(':')), rules));
  const head = lines.slice(0, MAX_GREP_MATCHES);
  const suffix = lines.length > MAX_GREP_MATCHES ? `\n… ${lines.length - MAX_GREP_MATCHES} more matches (truncated)` : '';
  return { output: `${lines.length} matches\n${head.join('\n')}${suffix}` };
}

// --- run_command (permission-gated) ---------------------------------------------

const BLOCKED = /\brm\s+-rf\s+[/~]|\bmkfs\b|:\(\)\{.*\};:|dd\s+if=\/dev\/[\w]+\s+of=\/dev\/|shutdown|reboot/i;

export async function runCommand(space, repo, args) {
  assertRepo(space, repo);
  const command = String(args?.command || '').trim();
  if (!command || command.length > 2000) throw new Error('Invalid command');
  if (BLOCKED.test(command)) throw new Error('Command blocked by safety policy');

  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'nixre-agent-'));
  try {
    await exec('git', ['clone', '--depth', '1', '--quiet', repoDir(space, repo), workdir], { timeout: 60_000 });
    const output = await new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', command], { cwd: workdir, env: { ...process.env, CI: '1' } });
      let out = '';
      let truncated = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Command timed out after ${MAX_CMD_MS / 1000}s`));
      }, MAX_CMD_MS);
      child.stdout.on('data', d => {
        if (out.length < MAX_CMD_BYTES) out += d.toString();
        else truncated = true;
      });
      child.stderr.on('data', d => {
        if (out.length < MAX_CMD_BYTES) out += d.toString();
        else truncated = true;
      });
      child.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (truncated) out += `\n… (output truncated at ${MAX_CMD_BYTES} bytes)`;
        resolve({ output: `exit code: ${code}\n${out.slice(0, MAX_CMD_BYTES)}` });
      });
    });
    return output;
  } finally {
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const MAX_SHOW_IMAGES = 4;
const MAX_SHOW_BYTES = 2 * 1024 * 1024;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export async function showImages(space, repo, args, permissions = {}) {
  assertRepo(space, repo);
  const raw = Array.isArray(args?.paths) ? args.paths : [];
  const rules = pathRules(permissions);
  const paths = raw
    .map(p => String(p || ''))
    .filter(Boolean)
    .filter(p => pathAllowed(p, rules))
    .slice(0, MAX_SHOW_IMAGES);
  if (paths.length === 0) throw new Error('paths required');
  const dir = repoDir(space, repo);
  const images = [];
  const notes = [];
  for (const p of paths) {
    try {
      const safe = assertSafePath(p);
      if (!IMAGE_EXT.test(safe)) {
        notes.push(`${safe}: not an image`);
        continue;
      }
      const ext = safe.split('.').pop().toLowerCase();
      const { stdout } = await exec('git', ['-C', dir, 'show', `HEAD:${safe}`], {
        encoding: 'buffer',
        maxBuffer: MAX_SHOW_BYTES + 1024,
        timeout: 15_000,
      });
      const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '', 'binary');
      if (buf.length > MAX_SHOW_BYTES) {
        notes.push(`${safe}: too large (max ${MAX_SHOW_BYTES / 1024 / 1024}MB)`);
        continue;
      }
      const mime = MIME[ext] || 'image/png';
      images.push({
        path: safe,
        mime,
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
      });
    } catch {
      notes.push(`${p}: not found`);
    }
  }
  return {
    output: JSON.stringify({
      images,
      note: notes.length ? notes.join('; ') : undefined,
    }),
  };
}

const EXECUTORS = {
  list_files: (space, repo, args, permissions) => listFiles(space, repo, args, permissions),
  read_file: (space, repo, args, permissions) => readFile(space, repo, args, permissions),
  search_code: (space, repo, args, permissions) => searchCode(space, repo, args, permissions),
  run_command: (space, repo, args) => runCommand(space, repo, args),
  show_images: (space, repo, args, permissions) => showImages(space, repo, args, permissions),
  web_search: (space, repo, args) => webSearchTool(args),
};

// --- web_search (permission-gated) ---------------------------------------------

async function webSearchTool(args) {
  const query = String(args?.query || '').trim();
  if (!query || query.length > 500) throw new Error('Invalid search query');
  const { results } = await webSearch(query, { maxResults: Number(args?.max_results) || undefined });
  if (results.length === 0) return { output: 'No results.' };
  const lines = results.map((r, i) => {
    const snippet = r.content ? `\n   ${r.content.slice(0, 300)}` : '';
    return `${i + 1}. ${r.title}\n   ${r.url}${snippet}`;
  });
  return { output: `${results.length} results\n\n${lines.join('\n\n')}` };
}

/**
 * Execute a tool for a user. `permissions` comes from the caller's repo
 * access profile: { canRunBash, canRunTests, canSearchWeb, allowedPaths,
 * blockedPaths } — absent profile means read-only tools only.
 */
export async function executeTool(tool, space, repo, args, permissions = {}) {
  const fn = EXECUTORS[tool];
  if (!fn) throw new Error(`Unknown tool '${tool}'`);
  if (tool === 'run_command') {
    const allowed = permissions.canRunBash === true || permissions.canRunTests === true;
    if (!allowed) {
      throw new Error(
        "run_command requires the 'Run shell commands' or 'Run tests' permission for this repo (Assistant → repo settings).",
      );
    }
  }
  if (tool === 'web_search') {
    if (permissions.canSearchWeb !== true) {
      throw new Error(
        "web_search requires the 'Search the web' permission for this repo (Assistant → repo settings).",
      );
    }
  }
  return fn(space, repo, args, permissions);
}
