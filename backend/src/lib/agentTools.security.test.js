import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Intercept dependencies, not implementation text. Any local process launch
// fails the test, including git clones before a would-be shell fallback.
const state = { enabled: true, error: null, probeError: null, calls: [], local: [] };
globalThis.__agentToolsSecurity = state;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === new URL('./agentTools.js', import.meta.url).href) {
      if (specifier === './agentSandbox.js') return { url: 'test:tools-sandbox', shortCircuit: true };
      if (specifier === 'node:child_process') return { url: 'test:tools-process', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'test:tools-process') return { format: 'module', shortCircuit: true, source: `
      export function execFile(...args) { globalThis.__agentToolsSecurity.local.push(args); throw Error('LOCAL EXEC'); }
      export const spawn = execFile;
    ` };
    if (url === 'test:tools-sandbox') return { format: 'module', shortCircuit: true, source: `
      const state = globalThis.__agentToolsSecurity;
      export async function isSandboxEnabled() { if (state.probeError) throw state.probeError; return state.enabled; }
      export async function runCommandInSandbox(args) {
        state.calls.push(args);
        if (state.error) throw state.error;
        return { output: 'sandbox only' };
      }
      export const writeFileInSandbox = runCommandInSandbox;
      export async function readFileInSandbox() { return null; }
      export async function agentWorkspaceOperation() { return null; }
    ` };
    return next(url, context);
  },
});
const { runCommand, writeFile } = await import('./agentTools.js');
after(() => { hooks.deregister(); delete globalThis.__agentToolsSecurity; });

const context = { userId: 'alice', conversationId: 'chat', repoPath: 'team/repo' };

test('run_command rejects missing context without spawning locally', async () => {
  for (const value of [{}, { userId: 'alice' }, { ...context, conversationId: undefined }, { ...context, repoPath: undefined }]) {
    await assert.rejects(runCommand('team', 'repo', { command: 'echo safe' }, {}, value), /requires an authenticated conversation/);
  }
  assert.deepEqual(state.local, []);
  assert.deepEqual(state.calls, []);
});

test('Docker unavailability and sandbox exceptions never fall back', async () => {
  state.enabled = false;
  await assert.rejects(runCommand('team', 'repo', { command: 'echo safe' }, {}, context), /Docker is required/);
  state.enabled = true;
  state.probeError = new Error('Docker probe failed');
  await assert.rejects(runCommand('team', 'repo', { command: 'echo safe' }, {}, context), /Docker probe failed/);
  state.probeError = null;
  state.error = new Error('sandbox failed');
  await assert.rejects(runCommand('team', 'repo', { command: 'echo safe' }, {}, context), /sandbox failed/);
  await assert.rejects(writeFile('team', 'repo', { path: 'file', content: 'safe' }, {}, context), /sandbox failed/);
  state.error = null;
  assert.deepEqual(state.local, []);
});

test('normal assistant command delegates only to its sandbox', async () => {
  assert.deepEqual(await runCommand('team', 'repo', { command: 'echo safe' }, {}, context), { output: 'sandbox only' });
  assert.equal(state.calls.at(-1).conversationId, 'chat');
  assert.equal(state.calls.at(-1).userId, 'alice');
  assert.deepEqual(state.local, []);
});
