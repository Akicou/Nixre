// Claiming extra commit emails: first claim wins, sign-in addresses are off
// limits, an admin override can reassign. The fake pool mimics just the
// three statements lib/userEmails.js runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimEmail, normalizeEmail } from '../lib/userEmails.js';

function fakePool(users) {
  const claims = new Map();
  return {
    claims,
    async query(sql, [email, uid]) {
      if (sql.includes('FROM users')) return { rows: users.filter(u => u.email === email).map(u => ({ uid: u.uid })) };
      if (sql.startsWith('INSERT') && sql.includes('DO NOTHING')) {
        if (claims.has(email)) return { rows: [] };
        claims.set(email, uid);
        return { rows: [{ email }] };
      }
      if (sql.startsWith('INSERT')) { claims.set(email, uid); return { rows: [] }; }
      if (sql.includes('FROM user_emails')) return { rows: claims.has(email) ? [{ user_uid: claims.get(email) }] : [] };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

test('normalizeEmail trims, lowercases and rejects junk', () => {
  assert.equal(normalizeEmail('  Me@Home.Example '), 'me@home.example');
  for (const bad of ['', 'nope', 'a b@c.d', '<x@y.z>', null]) assert.equal(normalizeEmail(bad), null);
});

test('first claim wins; sign-in addresses and rival claims are refused', async () => {
  const pool = fakePool([{ uid: 'ada', email: 'ada@x.dev' }, { uid: 'bob', email: 'bob@x.dev' }]);
  assert.deepEqual(await claimEmail(pool, 'ada', 'Me@Home.dev'), { ok: true, email: 'me@home.dev' });
  assert.equal((await claimEmail(pool, 'ada', 'me@home.dev')).ok, true, 'claiming your own again is fine');
  const rival = await claimEmail(pool, 'bob', 'me@home.dev');
  assert.equal(rival.status, 409);
  assert.equal(pool.claims.get('me@home.dev'), 'ada');
  assert.equal((await claimEmail(pool, 'bob', 'ADA@x.dev')).status, 409, "ada's sign-in address");
  assert.equal((await claimEmail(pool, 'bob', 'not an email')).status, 400);
});

test('an admin override moves a claim', async () => {
  const pool = fakePool([{ uid: 'ada', email: 'ada@x.dev' }, { uid: 'bob', email: 'bob@x.dev' }]);
  await claimEmail(pool, 'ada', 'shared@x.dev');
  assert.equal((await claimEmail(pool, 'bob', 'shared@x.dev', { override: true })).ok, true);
  assert.equal(pool.claims.get('shared@x.dev'), 'bob');
});
