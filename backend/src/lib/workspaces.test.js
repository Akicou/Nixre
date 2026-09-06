// Workspace target parsing — pure functions, no DB / network / git needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  UNRESTRICTED_PATH,
  parseWorkspacePath,
  workspaceGitDir,
  workspaceContextBlock,
  resolveWorkspace,
} from './workspaces.js';

test('parseWorkspacePath classifies hosted repos', () => {
  const ws = parseWorkspacePath('acme/website');
  assert.equal(ws.kind, 'nixre');
  assert.equal(ws.space, 'acme');
  assert.equal(ws.repo, 'website');
});

test('parseWorkspacePath classifies github targets', () => {
  const ws = parseWorkspacePath('github/facebook/react');
  assert.equal(ws.kind, 'github');
  assert.equal(ws.owner, 'facebook');
  assert.equal(ws.space, 'facebook');
  assert.equal(ws.repo, 'react');
  assert.equal(ws.fullName, 'facebook/react');

  const dotted = parseWorkspacePath('github/some.user/some-repo.name.js');
  assert.equal(dotted.kind, 'github');
});

test('parseWorkspacePath treats missing value as unrestricted', () => {
  for (const input of ['', null, undefined, UNRESTRICTED_PATH]) {
    assert.equal(parseWorkspacePath(input).kind, 'unrestricted');
  }
});

test('parseWorkspacePath rejects malformed targets', () => {
  for (const bad of [
    'a/b/c/d',
    '../etc/passwd',
    'space/../secret',
    'space/repo\nnewline',
    'github/o wner/repo',
  ]) {
    assert.equal(parseWorkspacePath(bad).kind, 'invalid', `expected invalid for ${JSON.stringify(bad)}`);
  }
  // Two segments never mean GitHub — including a space literally named
  // "github" (only the three-segment form selects github.com targets).
  const twoSeg = parseWorkspacePath('github/owner');
  assert.equal(twoSeg.kind, 'nixre');
});

test('workspaceGitDir maps kinds under REPOS_ROOT without escaping it', () => {
  const nixreDir = workspaceGitDir(parseWorkspacePath('acme/website'));
  assert.equal(nixreDir, path.join('/data/repos', 'acme', 'website.git'));

  const ghDir = String(workspaceGitDir(parseWorkspacePath('github/facebook/react')));
  assert.ok(ghDir.split(path.sep).includes('.mirrors'));
  assert.ok(ghDir.endsWith(path.join('github', 'facebook', 'react.git')));

  assert.equal(workspaceGitDir(parseWorkspacePath(UNRESTRICTED_PATH)), null);
});

// Minimal pool stub: answers the repo-visibility lookup. Mirrors the shape
// resolveWorkspace relies on (a .query returning { rows }).
function stubPool({ isPublic = true, member = true } = {}) {
  return {
    async query(sql, params) {
      if (/FROM repos WHERE space_uid/.test(sql)) {
        return { rows: [{ space_uid: params[0], is_public: isPublic }] };
      }
      if (/FROM space_members/.test(sql)) {
        return { rows: member ? [{ ok: 1 }] : [] };
      }
      if (/FROM users WHERE uid/.test(sql)) {
        return { rows: [{ uid: params[0], admin: false, blocked: false }] };
      }
      return { rows: [] };
    },
  };
}

// Regression: resolveWorkspace must attach the .dir the read/clone tools read
// from context.workspace (agentTools.js). It was returning the parse result
// without .dir, so list_files/read_file/search_code threw "no repository" and
// a github repo looked like it never got initialised. The nixre branch needs
// no DB/network, so it's covered directly; the github/lib mapping is covered
// by the workspaceGitDir test above (the .dir value is workspaceGitDir(ws)).
test('resolveWorkspace attaches .dir for a hosted repo', async () => {
  const ws = await resolveWorkspace(stubPool(), { uid: 'u1' }, 'acme/website');
  assert.equal(ws.kind, 'nixre');
  assert.equal(ws.dir, path.join('/data/repos', 'acme', 'website.git'));
});

test('resolveWorkspace attaches dir:null for unrestricted', async () => {
  const ws = await resolveWorkspace(stubPool(), { uid: 'u1' }, UNRESTRICTED_PATH);
  assert.equal(ws.kind, 'unrestricted');
  assert.equal(ws.dir, null);
});

// Security regression: workspace resolution used to ignore its pool argument
// entirely, so /ai/tools read any private repo for any authenticated caller.
test('resolveWorkspace refuses a private repo the caller cannot read', async () => {
  await assert.rejects(
    () => resolveWorkspace(stubPool({ isPublic: false, member: false }), { uid: 'u1' }, 'acme/website'),
    err => err.status === 404 && /not found/.test(err.message),
  );
});

test('resolveWorkspace allows a private repo the caller is a member of', async () => {
  const ws = await resolveWorkspace(
    stubPool({ isPublic: false, member: true }),
    { uid: 'u1' },
    'acme/website',
  );
  assert.equal(ws.kind, 'nixre');
});

test('resolveWorkspace fails closed without a pool or caller', async () => {
  await assert.rejects(() => resolveWorkspace(null, { uid: 'u1' }, 'acme/website'));
  await assert.rejects(() => resolveWorkspace(stubPool(), null, 'acme/website'));
});

test('workspaceContextBlock describes every kind with a target line', () => {
  const blocks = [
    ['nixre', workspaceContextBlock({ kind: 'nixre', space: 'acme', repo: 'website' })],
    ['github', workspaceContextBlock({ kind: 'github', owner: 'facebook', fullName: 'facebook/react' })],
    ['unrestricted', workspaceContextBlock({ kind: 'unrestricted', dir: null })],
  ];
  for (const [kind, block] of blocks) {
    assert.match(block, /<workspace>/);
    assert.match(block, /<\/workspace>/);
    if (kind === 'nixre') assert.match(block, /acme\/website/);
    if (kind === 'github') assert.match(block, /github\.com/);
    if (kind === 'unrestricted') assert.match(block, /Unrestricted mode/);
  }
});
