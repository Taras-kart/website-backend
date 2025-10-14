require('dotenv').config();
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';

const sslOption =
  connectionString.includes('sslmode=require')
    ? true
    : { rejectUnauthorized: false };

if (!global.pgPool) {
  global.pgPool = new Pool({
    connectionString,
    ssl: sslOption,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
}

module.exports = global.pgPool;
