const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://h5pld5:xau_ijXYyK3RMaZ91wJ64ig5qUmauAtEp3J61@eu-central-1.sql.xata.sh:5432/taraskart:main?sslmode=require',
  ssl: { require: true, rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

module.exports = pool;
