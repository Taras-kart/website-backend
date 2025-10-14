// D:\shopping-backend\db.js
require('dotenv').config();
const { Pool } = require('pg');

function withSslmodeRequire(cs) {
  if (!cs) return '';
  if (cs.includes('sslmode=')) return cs;
  return cs.includes('?') ? `${cs}&sslmode=require` : `${cs}?sslmode=require`;
}

const CONNECTION_STRING = withSslmodeRequire(
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.SUPABASE_DB_URL ||
  ''
);

if (!global._pgPool) {
  global._pgPool = new Pool({
    connectionString: CONNECTION_STRING,
    ssl: { require: true, rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
}

module.exports = global._pgPool;
