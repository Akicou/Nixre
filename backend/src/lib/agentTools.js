// Agent tools — sandboxed repo operations the assistant can invoke.
//
// Read-only tools (list_files, read_file, search_code) work against the bare
// repo on disk via git plumbing and are safe to expose to any authenticated
// user with repo access. run_command clones the repo to a temp dir and execs
// a shell command there — gated behind the caller's per-repo access profile
// (canRunBash / canRunTests), with hard timeouts and output caps.
//
// Every tool returns { output } or throws; the route maps errors to text.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { repoDir } from '../git/repo.js';

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

// --- read-only tools ----------------------------------------------------------

export async function listFiles(space, repo) {
  assertRepo(space, repo);
  const out = await git(repoDir(space, repo), ['ls-tree', '-r', '--name-only', 'HEAD']);
  const files = out.split('\n').filter(Boolean);
  const head = files.slice(0, MAX_LIST);
  const suffix = files.length > MAX_LIST ? `\n… ${files.length - MAX_LIST} more (truncated)` : '';
  return { output: `${files.length} files\n${head.join('\n')}${suffix}` };
}

export async function readFile(space, repo, args) {
  assertRepo(space, repo);
  const p = assertSafePath(args?.path);
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

export async function searchCode(space, repo, args) {
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
  const lines = out.split('\n').filter(Boolean);
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

const EXECUTORS = {
  list_files: (space, repo, args) => listFiles(space, repo, args),
  read_file: (space, repo, args) => readFile(space, repo, args),
  search_code: (space, repo, args) => searchCode(space, repo, args),
  run_command: (space, repo, args) => runCommand(space, repo, args),
};

/**
 * Execute a tool for a user. `permissions` comes from the caller's repo
 * access profile: { canEditFiles, canRunBash, canRunTests, ... } — absent
 * profile means read-only tools only.
 */
export async function executeTool(tool, space, repo, args, permissions = {}) {
  const fn = EXECUTORS[tool];
  if (!fn) throw new Error(`Unknown tool '${tool}'`);
  if (tool === 'run_command') {
    const allowed = permissions.canRunBash === true || permissions.canRunTests === true;
    if (!allowed) {
      throw new Error(
        "run_command requires the 'Run bash' or 'Run tests' permission for this repo (Assistant → repo settings).",
      );
    }
  }
  return fn(space, repo, args);
}
