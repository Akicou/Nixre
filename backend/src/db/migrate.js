// Migration runner — applies SQL files from src/db/migrations in order,
// tracking applied versions in the schema_migrations table.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertSecretConfiguration, decryptSecret, encryptSecret } from '../lib/ai.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Called only inside migrate's locked transaction. Re-run on every boot so
// key rotation and restored legacy backups use the same verified upgrade path.
async function reencryptSecrets(client) {
  const targets = [
    ['ai_provider_profiles', ['user_uid'], 'api_key_enc'],
    ['ai_providers', ['id'], 'api_key_enc'],
    ['user_secrets', ['user_uid', 'kind'], 'secret_enc'],
    ['user_stt', ['user_uid'], 'api_key_enc'],
    ['service_env_vars', ['service_id', 'key'], 'value_enc'],
    ['repo_webhooks', ['id'], 'secret_enc'],
  ];
  let verified = 0;
  let rewritten = 0;
  for (const [table, keys, column] of targets) {
    const webhook = table === 'repo_webhooks';
    // Identifiers are the fixed schema list above, never request input.
    const { rows } = await client.query(
      `SELECT ${keys.join(', ')}, ${column}${webhook ? ', secret' : ''} FROM ${table}
       ${webhook ? '' : `WHERE ${column} IS NOT NULL`} FOR UPDATE`,
    );
    for (const row of rows) {
      try {
        const plain = row[column] == null && webhook ? row.secret : decryptSecret(row[column]);
        let current = false;
        if (row[column]?.startsWith('v1.')) {
          try {
            current = decryptSecret(row[column], { allowLegacy: false }) === plain;
          } catch { /* previous versioned key: rotate below */ }
        }
        if (!current || (webhook && row.secret !== '')) {
          const encrypted = current ? row[column] : encryptSecret(plain);
          const result = await client.query(
            `UPDATE ${table} SET ${column} = $1${webhook ? ", secret = ''" : ''}
             WHERE ${keys.map((key, i) => `${key} = $${i + 2}`).join(' AND ')}
             RETURNING ${column}${webhook ? ', secret' : ''}`,
            [encrypted, ...keys.map(key => row[key])],
          );
          if (result.rows.length !== 1 ||
              decryptSecret(result.rows[0][column], { allowLegacy: false }) !== plain ||
              (webhook && result.rows[0].secret !== '')) {
            throw new Error('Encrypted secret readback verification failed');
          }
          rewritten++;
        }
        verified++;
      } catch {
        // Never log plaintext, ciphertext, or driver errors containing values.
        throw new Error(`Secret migration failed for ${table}.${column}; transaction rolled back. Preserve the old key and check AI_SECRET_LEGACY and legacy recovery settings.`);
      }
    }
  }
  return { verified, rewritten };
}

export async function migrate(pool) {
  assertSecretConfiguration();
  const client = await pool.connect();
  const completed = [];
  let releaseError;
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('nixre.schema-migrations', 0))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(r => r.version));
    const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query(readFileSync(path.join(migrationsDir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      completed.push(file);
    }
    const secrets = await reencryptSecrets(client);
    await client.query('COMMIT');
    for (const file of completed) console.log(`[migrate] applied ${file}`);
    console.log(`[migrate] verified ${secrets.verified} secrets with current key; rewritten ${secrets.rewritten}`);
    return secrets;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { releaseError = rollbackError; }
    throw err;
  } finally {
    client.release(releaseError);
  }
}
