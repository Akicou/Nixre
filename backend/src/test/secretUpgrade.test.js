import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { encryptSecret, decryptSecret } from '../lib/ai.js';
import { migrate } from '../db/migrate.js';

const KEY = 'test-current-secret-0123456789abcdef';
const OLD_KEY = 'test-previous-secret-0123456789abcdef';
// Produced by origin/main's SHA256 derivation and AES-GCM encoding.
const FIXTURE = 'AQEBAQEBAQEBAQEB.T+gClrY/4rFDIIdEGtN6UA==.ydQAY5P9G++hwK6BkZGeuvxQxg==';
const envKeys = ['AI_SECRET', 'INTERNAL_TOKEN', 'AI_SECRET_LEGACY', 'NIXRE_SECRET_SALT',
  'NIXRE_SECRET_SALT_LEGACY', 'ALLOW_LEGACY_DEFAULT_SECRET_RECOVERY'];
const original = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
beforeEach(() => {
  for (const k of envKeys) delete process.env[k];
  process.env.AI_SECRET = KEY;
});
afterEach(() => {
  for (const k of envKeys) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

function legacy(material, { hkdf = false, salt = 'nixre.instance.secret.v1' } = {}) {
  const key = hkdf ? Buffer.from(crypto.hkdfSync('sha256', material, salt, 'nixre-secret-encryption-v1', 32))
    : crypto.createHash('sha256').update(material).digest();
  const iv = Buffer.alloc(12, 1);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update('legacy-provider-key', 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
}

test('new secrets are versioned, authenticated and survive a process restart', () => {
  const ciphertext = encryptSecret('restart-fixture');
  assert.match(ciphertext, /^v1\./);
  assert.equal(decryptSecret(ciphertext, { allowLegacy: false }), 'restart-fixture');
  const moduleUrl = new URL('../lib/ai.js', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { decryptSecret } from ${JSON.stringify(moduleUrl)}; process.stdout.write(decryptSecret(process.env.FIXTURE));`],
  { env: { ...process.env, FIXTURE: ciphertext }, encoding: 'utf8' });
  assert.equal(output, 'restart-fixture');
  assert.throws(() => decryptSecret(ciphertext.slice(3)), /decryption failed/);
  assert.throws(() => decryptSecret(ciphertext.replace(/^v1/, 'v2')), /format/);
  assert.equal(decryptSecret(encryptSecret('')), '');
});

test('old SHA256 and unversioned HKDF ciphertext remain readable', () => {
  assert.equal(legacy(KEY), FIXTURE);
  assert.equal(decryptSecret(FIXTURE), 'legacy-provider-key');
  assert.equal(decryptSecret(legacy(KEY, { hkdf: true })), 'legacy-provider-key');
  process.env.INTERNAL_TOKEN = OLD_KEY;
  assert.equal(decryptSecret(legacy(OLD_KEY)), 'legacy-provider-key');
  assert.throws(() => decryptSecret(FIXTURE, { allowLegacy: false }), /format/);
});

test('rotation requires explicit previous material; published defaults require two opt-ins', () => {
  assert.throws(() => decryptSecret(legacy(OLD_KEY)), /decryption failed/);
  process.env.AI_SECRET_LEGACY = OLD_KEY;
  assert.equal(decryptSecret(legacy(OLD_KEY)), 'legacy-provider-key');
  for (const published of ['nixre-dev-ai-secret', 'dev-internal-token-change-me', 'dev-ai-secret-change-me']) {
    delete process.env.AI_SECRET_LEGACY;
    delete process.env.ALLOW_LEGACY_DEFAULT_SECRET_RECOVERY;
    process.env.INTERNAL_TOKEN = published;
    assert.throws(() => decryptSecret(legacy(published)), /decryption failed/);
    process.env.AI_SECRET_LEGACY = published;
    assert.throws(() => decryptSecret(legacy(published)), /requires ALLOW_LEGACY/);
    process.env.ALLOW_LEGACY_DEFAULT_SECRET_RECOVERY = '1';
    assert.equal(decryptSecret(legacy(published)), 'legacy-provider-key');
  }
});

test('missing production material and damaged ciphertext fail loudly', () => {
  delete process.env.AI_SECRET;
  assert.throws(() => encryptSecret('no-random-key'), /AI_SECRET/);
  assert.throws(() => decryptSecret(FIXTURE), /AI_SECRET/);
  process.env.AI_SECRET = 'dev-ai-secret-change-me';
  assert.throws(() => encryptSecret('no-default'), /AI_SECRET/);
  process.env.AI_SECRET = KEY;
  assert.throws(() => decryptSecret('broken.ciphertext.fixture'), /encoding/);
  const parts = FIXTURE.split('.');
  parts[1] = Buffer.alloc(16).toString('base64');
  assert.throws(() => decryptSecret(parts.join('.')), /decryption failed/);
});

const targets = {
  ai_provider_profiles: ['api_key_enc', ['user_uid']],
  ai_providers: ['api_key_enc', ['id']],
  user_secrets: ['secret_enc', ['user_uid', 'kind']],
  user_stt: ['api_key_enc', ['user_uid']],
  service_env_vars: ['value_enc', ['service_id', 'key']],
  repo_webhooks: ['secret_enc', ['id']],
};

function fixturePool({ corrupt = false, failReadback = false, applied = true } = {}) {
  const data = {
    ai_provider_profiles: [{ user_uid: 'u', api_key_enc: FIXTURE }],
    ai_providers: [{ id: 1, api_key_enc: FIXTURE }, { id: 2, api_key_enc: null }],
    user_secrets: [{ user_uid: 'u', kind: 'github', secret_enc: FIXTURE }],
    user_stt: [{ user_uid: 'u', api_key_enc: FIXTURE }],
    service_env_vars: [{ service_id: 1, key: 'PASSWORD', value_enc: FIXTURE }],
    repo_webhooks: [{ id: 1, secret_enc: null, secret: 'legacy-hook-key' },
      { id: 2, secret_enc: corrupt ? 'broken.ciphertext.fixture' : encryptSecret('current-hook'), secret: '' }],
  };
  let versions = applied ? readdirSync(new URL('../db/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')) : [];
  const queries = [];
  let snapshot;
  let released = false;
  const client = {
    async query(sql, params = []) {
      queries.push(sql.trim());
      if (sql === 'BEGIN') snapshot = structuredClone({ data, versions });
      if (sql === 'ROLLBACK') { Object.assign(data, snapshot.data); versions = snapshot.versions; }
      if (sql === 'SELECT version FROM schema_migrations') return { rows: versions.map(version => ({ version })) };
      if (sql.startsWith('INSERT INTO schema_migrations')) versions.push(params[0]);
      const read = sql.match(/FROM (\w+)\s+(?:WHERE .*?\s+)?FOR UPDATE/);
      if (read) {
        const table = read[1];
        return { rows: structuredClone(data[table].filter(row => table === 'repo_webhooks' || row[targets[table][0]] != null)) };
      }
      const update = sql.match(/^UPDATE (\w+) SET (\w+) = \$1/);
      if (update) {
        const [, table, column] = update;
        const row = data[table].find(r => targets[table][1].every((key, i) => r[key] === params[i + 1]));
        row[column] = params[0];
        if (table === 'repo_webhooks') row.secret = '';
        return { rows: [{ ...row, ...(failReadback ? { [column]: encryptSecret('wrong-readback') } : {}) }] };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
  return { data, queries, get released() { return released; }, get versions() { return versions; },
    query() { throw new Error('Migration must use its dedicated client'); }, async connect() { return client; } };
}

test('migration atomically rewrites every encrypted store and plaintext webhooks, then is idempotent', async () => {
  const pool = fixturePool({ applied: false });
  const result = await migrate(pool);
  assert.deepEqual(result, { verified: 7, rewritten: 6 });
  assert.match(pool.queries[1], /pg_advisory_xact_lock.*schema-migrations/);
  assert.equal(pool.queries.at(-1), 'COMMIT');
  assert.equal(pool.released, true);
  for (const [table, [column]] of Object.entries(targets)) {
    for (const row of pool.data[table]) {
      if (row[column] == null) continue;
      assert.match(row[column], /^v1\./);
      assert.equal(typeof decryptSecret(row[column], { allowLegacy: false }), 'string');
      if (table === 'repo_webhooks') assert.equal(row.secret, '');
    }
  }
  const after = structuredClone(pool.data);
  assert.deepEqual(await migrate(pool), { verified: 7, rewritten: 0 });
  assert.deepEqual(pool.data, after);
});

test('failed decryption or readback rolls back all ciphertext, plaintext clearing and SQL versions', async () => {
  for (const options of [{ corrupt: true }, { failReadback: true }]) {
    const pool = fixturePool({ ...options, applied: false });
    const before = structuredClone(pool.data);
    await assert.rejects(migrate(pool), /Secret migration failed/);
    assert.deepEqual(pool.data, before);
    assert.deepEqual(pool.versions, []);
    assert.equal(pool.queries.at(-1), 'ROLLBACK');
    assert.equal(pool.released, true);
  }
});

test('versioned key and salt rotation is verified before the legacy key can be removed', async () => {
  const pool = fixturePool();
  await migrate(pool);
  process.env.AI_SECRET_LEGACY = KEY;
  process.env.NIXRE_SECRET_SALT_LEGACY = 'nixre.instance.secret.v1';
  process.env.AI_SECRET = OLD_KEY;
  process.env.NIXRE_SECRET_SALT = 'new-test-salt';
  assert.deepEqual(await migrate(pool), { verified: 7, rewritten: 7 });
  delete process.env.AI_SECRET_LEGACY;
  delete process.env.NIXRE_SECRET_SALT_LEGACY;
  assert.deepEqual(await migrate(pool), { verified: 7, rewritten: 0 });
});

test('updater rollback metadata fails closed for lost COMMIT responses and missing transaction guards', async () => {
  for (const failure of ['statement', 'commit', 'lost-guard']) {
    const pool = fixturePool();
    const client = await pool.connect();
    const query = client.query.bind(client);
    client.query = async (sql, params) => {
      if ((failure === 'commit' && sql === 'COMMIT') || (failure !== 'commit' && sql === 'SELECT version FROM schema_migrations') ||
          (failure === 'lost-guard' && sql === 'ROLLBACK TO SAVEPOINT nixre_migration_atomic')) throw new Error('fixture failure');
      return query(sql, params);
    };
    await assert.rejects(migrate(pool), error => {
      assert.equal(error.migrationRollbackConfirmed, failure === 'statement');
      if (failure === 'commit') assert.equal(error.migrationPhase, 'commit');
      return true;
    });
  }
});
