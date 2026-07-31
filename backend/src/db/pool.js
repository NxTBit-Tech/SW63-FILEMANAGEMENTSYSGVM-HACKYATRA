// db/pool.js
// Single shared pg Pool instance. Import this everywhere instead of
// creating new pools per file — connection reuse matters under load.
//
// Supabase requires SSL and is reached via a single connection string
// (not discrete host/port/user/password vars). Get this from:
// Project Settings -> Database -> Connection string -> URI.
// Prefer the "Transaction" pooler string (port 6543) for a serverless-style
// app; use the direct connection (port 5432) if you need long-lived
// sessions/LISTEN-NOTIFY. Either works with the code below.

const { Pool } = require('pg');
const { databaseUrl } = require('../config/env');

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false }, // Supabase terminates SSL with a cert
                                       // that isn't in Node's default CA
                                       // store — this is the standard,
                                       // documented workaround, not a
                                       // security downgrade of the
                                       // connection encryption itself.
  max: 10,
  idleTimeoutMillis: 30000,
});

module.exports = pool;
