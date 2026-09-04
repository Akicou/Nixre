// Workspace target parsing — pure functions, no DB / network / git needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  UNRESTRICTED_PATH,
  parseWorkspacePath,
  workspaceGitDir,
  workspaceContextBlock,
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
