// Machine-readable, credential-free result for the independent host updater.
import { migrate } from './migrate.js';
import { pool } from './pool.js';

try {
  await migrate(pool);
  const { rows } = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  console.log(`NIXRE_MIGRATION_RESULT=${JSON.stringify({ ok: true, versions: rows.map(row => row.version) })}`);
} catch (error) {
  console.log(`NIXRE_MIGRATION_RESULT=${JSON.stringify({
    ok: false, version: error.migrationVersion || null,
    phase: error.migrationPhase || 'connect',
    code: /^[A-Z0-9]{5}$/.test(error.code || '') ? error.code : null,
    rollbackConfirmed: error.migrationRollbackConfirmed === true,
  })}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
