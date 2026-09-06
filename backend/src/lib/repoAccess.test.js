// Repository visibility — the rule every read endpoint must apply.
//
// Regression: the forge API used to check only that a repo row existed, so any
// authenticated user could read every private repository. The git transport
// enforced is_public; the JSON endpoints did not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReadRepo, canWriteRepo, loadReadableRepo } from './repoAccess.js';

// Pool stub: one configurable repo row plus a membership list.
function stubPool({ isPublic = false, members = [], repo = null } = {}) {
  return {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      if (/FROM space_members/.test(sql)) {
        const uid = params[1];
        return { rows: members.includes(uid) ? [{ ok: 1 }] : [] };
      }
      if (/FROM repos WHERE space_uid/.test(sql)) {
        const row = repo ?? { space_uid: params[0], uid: params[1], is_public: isPublic };
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };
}

const admin = { uid: 'root', admin: true };
const member = { uid: 'dev', admin: false };
const outsider = { uid: 'stranger', admin: false };
const blockedMember = { uid: 'dev', admin: false, blocked: true };

test('public repos are readable by anyone', async () => {
  const repo = { space_uid: 'acme', is_public: true };
  assert.equal(await canReadRepo(stubPool(), repo, outsider), true);
});

test('private repos are readable by members', async () => {
  const pool = stubPool({ isPublic: false, members: ['dev'] });
  assert.equal(await canReadRepo(pool, { space_uid: 'acme', is_public: false }, member), true);
});

test('private repos are not readable by non-members', async () => {
  const pool = stubPool({ isPublic: false, members: ['dev'] });
  assert.equal(await canReadRepo(pool, { space_uid: 'acme', is_public: false }, outsider), false);
});

test('admins read every repo', async () => {
  const pool = stubPool({ isPublic: false, members: [] });
  assert.equal(await canReadRepo(pool, { space_uid: 'acme', is_public: false }, admin), true);
  // Admin short-circuits before the membership query.
  assert.equal(pool.calls.length, 0);
});

test('blocked users read nothing, even public repos', async () => {
  const pool = stubPool({ isPublic: true, members: ['dev'] });
  assert.equal(await canReadRepo(pool, { space_uid: 'acme', is_public: true }, blockedMember), false);
  assert.equal(await canWriteRepo(pool, { space_uid: 'acme', is_public: true }, blockedMember), false);
});

test('missing repo or user is denied', async () => {
  assert.equal(await canReadRepo(stubPool(), null, member), false);
  assert.equal(await canReadRepo(stubPool(), { space_uid: 'acme' }, null), false);
});

test('loadReadableRepo returns 404 (not 403) for a private repo', async () => {
  const pool = stubPool({ isPublic: false, members: [] });
  const out = await loadReadableRepo(pool, 'acme', 'secret', outsider);
  assert.ok(out.error);
  // 403 would confirm the private repo exists — it must be 404.
  assert.equal(out.error.status, 404);
  assert.equal(out.error.message, 'Repository not found');
});

test('loadReadableRepo returns the repo for a member', async () => {
  const pool = stubPool({ isPublic: false, members: ['dev'] });
  const out = await loadReadableRepo(pool, 'acme', 'secret', member);
  assert.ok(out.repo);
  assert.equal(out.error, undefined);
});

test('loadReadableRepo returns 404 for a repo that does not exist', async () => {
  const pool = stubPool({ isPublic: true, repo: null });
  pool.query = async () => ({ rows: [] });
  const out = await loadReadableRepo(pool, 'acme', 'nope', admin);
  assert.equal(out.error?.status, 404);
});
