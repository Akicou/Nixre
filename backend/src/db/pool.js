// Shared pg pool — one pool per process, used by the server and libs that
// need direct DB access (e.g. the agent sandbox mints short-lived PATs).

import pg from 'pg';

export const pool = new pg.Pool({
  // Explicit URLs remain supported for external installations. Compose uses
  // standard PG* variables so passwords need no URI escaping.
  ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
});
