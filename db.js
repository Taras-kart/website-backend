/*const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  user: 'postgres',
  password: '9010@Gane',
  database: 'postgres',
  port: 5432
});

module.exports = pool; */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false  
  }
});

module.exports = pool;

