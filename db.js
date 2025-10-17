const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://h5pld5:xau_LRR5FBytMeO7OU8L8KgvFh5uvKkgd0tv0@eu-central-1.sql.xata.sh/taraskart:main?sslmode=require',
  ssl: { require: true, rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

module.exports = pool;
