// Production IO bindings for the deployment engine — dockerode, git CLI, and
// HTTP probes. Deliberately thin: all behavior lives in deployments.js where
// these are replaced by fakes in tests.

import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import { repoDir } from '../git/repo.js';

const DOCKER_SOCKET = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') || '/var/run/docker.sock';

let docker = null;
let dockerAvailable = false;

// Same lazy-probe contract as agentSandbox: a failed early check never
// disables deployments for the process lifetime.
export async function getDocker() {
  if (dockerAvailable && docker) return docker;
  try {
    const { access, constants } = await import('node:fs/promises');
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
  return docker;
}

function gitRun(bareDir, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', bareDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const onAbort = () => child.kill();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('error', err => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', code => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0 || (signal?.aborted && code !== null)) resolve(stdout);
      else reject(new Error(`git ${args[0]} failed (${code}): ${stderr.slice(0, 300)}`));
    });
  });
}

export async function resolveRef(space, repo, ref) {
  const dir = repoDir(space, repo);
  const sha = (await gitRun(dir, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  let message = '';
  try {
    message = (
      await gitRun(dir, [
        'log',
        '-1',
        '--format=%s',
        '--no-show-signature',
        sha,
      ])
    ).trim();
  } catch {
    /* subject is best-effort */
  }
  return { sha, message };
}

export async function archiveTar(space, repo, spec, signal) {
  const dir = repoDir(space, repo);
  return gitStream(dir, ['archive', '--format=tar', spec], signal);
}

function gitStream(bareDir, args, signal) {
  const child = spawn('git', ['-C', bareDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => (stderr += d));
  const fail = () =>
    Object.assign(new Error(`git ${args[0]} failed: ${stderr.slice(0, 200)}`), { fatal: true });
  child.on('error', () => child.kill());
  const maybeFail = new Promise((_, reject) => {
    child.on('close', code => {
      if (code !== 0) reject(fail());
    });
  });
  // Rejected upstream errors propagate; success hands off the stdout stream.
  child.stdout.on('error', () => child.kill());
  void maybeFail.catch(err => child.stdout.destroy(err));
  const onAbort = () => {
    try {
      child.stdout.destroy(new Error('Build cancelled'));
    } catch {
      /* already gone */
    }
    child.kill();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return child.stdout;
}

export async function listTree(space, repo, ref) {
  const dir = repoDir(space, repo);
  const out = await gitRun(dir, ['ls-tree', '-r', '--name-only', ref]);
  return out.split('\n').filter(Boolean).map(l => l.replace(/^"|"$/g, ''));
}

// Any HTTP response counts as "app is up" — the goal is reaching a listening
// socket, not validating app semantics. Connection-level failures throw.
export function probeHttp() {
  return ({ host, port, path, timeoutMs }) =>
    new Promise((resolve, reject) => {
      const req = http.get(
        { host, port, path: path || '/', timeout: timeoutMs || 2500 },
        res => {
          res.resume();
          resolve({ ok: Boolean(res.statusCode), status: res.statusCode ?? null });
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error(`probe timed out after ${timeoutMs}ms`));
      });
      req.on('error', reject);
    });
}

// Attach app containers to core's own network so names/IPs resolve.
let coreNetworkName;
export async function networkName(docker) {
  if (coreNetworkName !== undefined) return coreNetworkName;
  coreNetworkName = '';
  try {
    const info = await docker.getContainer(os.hostname()).inspect();
    coreNetworkName = Object.keys(info.NetworkSettings?.Networks || {})[0] || '';
  } catch {
    /* not containerized — default bridge still works via resolved IPs */
  }
  return coreNetworkName;
}
