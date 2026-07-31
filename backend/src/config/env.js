// config/env.js
// Loads and validates required environment variables once, at boot.
// Import this at the top of server.js so a missing var fails fast
// instead of surfacing as a confusing runtime error later.

require('dotenv').config();

// Supabase gives you one connection string (Project Settings -> Database
// -> Connection string -> URI). Use that directly instead of PGHOST/PGPORT/etc.
const required = ['JWT_SECRET', 'DATABASE_URL'];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

module.exports = {
  port: process.env.PORT || 4000,
  jwtSecret: process.env.JWT_SECRET,
  databaseUrl: process.env.DATABASE_URL,
};
