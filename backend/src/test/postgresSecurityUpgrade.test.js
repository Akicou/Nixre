// Explicit opt-in: uses a disposable schema in a TEST database, never DATABASE_URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import express from 'express';
import { migrate } from '../db/migrate.js';
import { decryptSecret } from '../lib/ai.js';
import { authRoutes } from '../routes/auth.js';
import { forgeRoutes } from '../routes/forge.js';

const connectionString = process.env.NIXRE_TEST_DATABASE_URL;
const fixture = 'AQEBAQEBAQEBAQEB.T+gClrY/4rFDIIdEGtN6UA==.ydQAY5P9G++hwK6BkZGeuvxQxg==';

test('Postgres: populated old-schema upgrade, rollback, concurrent migrations and namespace allocation', {
  skip: !connectionString && 'Set NIXRE_TEST_DATABASE_URL to a disposable PostgreSQL test database',
}, async t => {
  process.env.AI_SECRET = 'test-current-secret-0123456789abcdef';
  process.env.NIXRE_REGISTRATION_CLOSED = 'false';
  delete process.env.AI_SECRET_LEGACY;
  delete process.env.NIXRE_SECRET_SALT;
  const admin = new pg.Pool({ connectionString });
  const schema = 'nixre_security_test_' + crypto.randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  const dir = new URL('../db/migrations/', import.meta.url);
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  await pool.query('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)');
  // Begin at the historical single-provider schema, with real encrypted data.
  for (const file of files.filter(f => f <= '007_ai.sql')) {
    await pool.query(readFileSync(new URL(file, dir), 'utf8'));
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
  }
  await pool.query(`INSERT INTO users (uid,email,display_name,password_hash,created,updated)
    VALUES ('owner','owner@example.test','Owner','unused',1,1)`);
  await pool.query(`INSERT INTO users (uid,email,display_name,password_hash,created,updated)
    VALUES ('name-clash','name-clash@example.test','Name clash','unused',1,1),
           ('case-clash','case-clash@example.test','Case clash','unused',1,1)`);
  await pool.query(`INSERT INTO spaces (uid,created_by,created,updated)
    VALUES ('name-clash','owner',1,1), ('CASE-CLASH','owner',1,1)`);
  await pool.query(`INSERT INTO space_members (space_uid,user_uid,role,created)
    VALUES ('name-clash','owner','owner',1), ('CASE-CLASH','owner','owner',1)`);
  await pool.query(`INSERT INTO ai_provider_profiles (user_uid,api_key_enc,updated_at) VALUES ('owner',$1,1)`, [fixture]);
  await pool.query(`INSERT INTO spaces (uid,created_by,created,updated) VALUES ('org','owner',1,1)`);
  const repo = (await pool.query(`INSERT INTO repos (space_uid,uid,created_by,created,updated)
    VALUES ('org','repo','owner',1,1) RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO repo_webhooks (repo_id,url,secret,created_by,created)
    VALUES ($1,'https://example.test/hook','plaintext-hook','owner',1)`, [repo]);
  const upgraded = await Promise.all([migrate(pool), migrate(pool)]);
  assert.equal(upgraded.reduce((sum, r) => sum + r.rewritten, 0), 2);
  // Pending 012 must neither acquire an existing organization nor create a
  // case-variant personal namespace beside it. Existing owners stay unchanged.
  const collisions = (await pool.query(`SELECT uid,is_personal,created_by FROM spaces
    WHERE lower(uid) IN ('name-clash','case-clash') ORDER BY uid`)).rows;
  assert.deepEqual(collisions, [
    { uid: 'CASE-CLASH', is_personal: false, created_by: 'owner' },
    { uid: 'name-clash', is_personal: false, created_by: 'owner' },
  ]);
  const collisionMembers = (await pool.query(`SELECT space_uid,user_uid,role FROM space_members
    WHERE lower(space_uid) IN ('name-clash','case-clash') ORDER BY space_uid`)).rows;
  assert.deepEqual(collisionMembers, [
    { space_uid: 'CASE-CLASH', user_uid: 'owner', role: 'owner' },
    { space_uid: 'name-clash', user_uid: 'owner', role: 'owner' },
  ]);
  assert.equal((await pool.query(`SELECT 1 FROM spaces s JOIN space_members m ON m.space_uid=s.uid
    WHERE s.uid='owner' AND s.is_personal=TRUE AND s.created_by='owner'
      AND m.user_uid='owner' AND m.role='owner'`)).rowCount, 1);
  const profile = (await pool.query('SELECT api_key_enc FROM ai_provider_profiles')).rows[0];
  assert.equal(decryptSecret(profile.api_key_enc, { allowLegacy: false }), 'legacy-provider-key');
  const hook = (await pool.query('SELECT secret,secret_enc FROM repo_webhooks')).rows[0];
  assert.equal(hook.secret, '');
  assert.equal(decryptSecret(hook.secret_enc, { allowLegacy: false }), 'plaintext-hook');

  // A migration-024 backup has all six secret stores, but no encrypted hooks.
  await pool.query(`DELETE FROM schema_migrations WHERE version = '025_security_hardening.sql'`);
  await pool.query('ALTER TABLE repo_webhooks DROP COLUMN secret_enc');
  await pool.query("UPDATE repo_webhooks SET secret = 'plaintext-hook'");
  await pool.query('UPDATE ai_provider_profiles SET api_key_enc=$1', [fixture]);
  await pool.query(`INSERT INTO ai_providers (user_uid,label,provider,api_key_enc,created,updated)
    VALUES ('owner','fixture','openai',$1,1,1)`, [fixture]);
  await pool.query(`INSERT INTO user_secrets (user_uid,kind,secret_enc,updated) VALUES ('owner','github',$1,1)`, [fixture]);
  await pool.query(`INSERT INTO user_stt (user_uid,base_url,model,api_key_enc,updated)
    VALUES ('owner','https://example.test','fixture',$1,1)`, [fixture]);
  const service = (await pool.query(`INSERT INTO deploy_services (repo_id,name,created_by,created,updated)
    VALUES ($1,'fixture','owner',1,1) RETURNING id`, [repo])).rows[0].id;
  await pool.query(`INSERT INTO service_env_vars (service_id,key,value_enc,updated) VALUES ($1,'KEY',$2,1)`, [service, fixture]);
  await pool.query(`UPDATE user_stt SET api_key_enc='broken.ciphertext.fixture'`);
  await assert.rejects(migrate(pool), /Secret migration failed/);
  assert.equal((await pool.query('SELECT api_key_enc FROM ai_providers')).rows[0].api_key_enc, fixture);
  assert.equal((await pool.query("SELECT 1 FROM schema_migrations WHERE version='025_security_hardening.sql'")).rowCount, 0);
  assert.equal((await pool.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema=$1 AND table_name='repo_webhooks' AND column_name='secret_enc'`, [schema])).rowCount, 0);
  await pool.query('UPDATE user_stt SET api_key_enc=$1', [fixture]);
  assert.deepEqual(await migrate(pool), { verified: 6, rewritten: 6 });
  assert.deepEqual(await migrate(pool), { verified: 6, rewritten: 0 });

  const app = express();
  app.use(express.json());
  const auth = () => (req, _res, next) => { req.auth = { user: { uid: 'owner', admin: false } }; next(); };
  app.use(authRoutes(pool, auth));
  app.use(forgeRoutes(pool, auth));
  app.use((err, _req, res, _next) => res.status(500).json({ message: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    await r.text();
    return r.status;
  };
  assert.equal(await post('/register', { uid: 'ORG', email: 'attack@example.test', password: 'fixture-password' }), 409);
  const results = await Promise.all([
    post('/register', { uid: 'Collision', email: 'collision@example.test', password: 'fixture-password' }),
    post('/spaces', { uid: 'collision' }),
  ]);
  assert.deepEqual(results.sort(), [201, 409]);
  assert.equal((await pool.query("SELECT * FROM spaces WHERE lower(uid)='collision'")).rowCount, 1);
  assert.equal((await pool.query("SELECT * FROM space_members WHERE lower(space_uid)='collision'")).rowCount, 1);
});
