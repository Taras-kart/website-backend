const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  user: 'postgres',
  password: '9010@Gane',
  database: 'postgres',
  port: 5432
});

module.exports = pool;
