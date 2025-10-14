// D:\shopping-backend\db.js
require('dotenv').config();
const { Pool } = require('pg');

const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.SUPABASE_DB_URL ||
  '';

if (!global._pgPool) {
  global._pgPool = new Pool({
    connectionString: CONNECTION_STRING,
    ssl: { require: true, rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  });
}

module.exports = global._pgPool;
