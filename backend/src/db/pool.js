// Shared pg pool — one pool per process, used by the server and libs that
// need direct DB access (e.g. the agent sandbox mints short-lived PATs).

import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://nixre:nixre@localhost:5432/nixre',
});
