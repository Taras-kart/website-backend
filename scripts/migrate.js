require('dotenv').config()
const fs = require('fs')
const path = require('path')
const pool = require('../db')
async function main() {
  const client = await pool.connect()
  try {
    const sql = fs.readFileSync(path.join(__dirname,'../migrations/001_catalogue_and_access.sql'),'utf8')
    const split = sql.indexOf('BEGIN;\nSELECT pg_advisory')
    await client.query(sql.slice(0,split))
    await client.query(sql.slice(split))
    console.log('Tara database upgrade completed')
  } catch(error) { await client.query('ROLLBACK'); console.error(error.message); process.exitCode=1 }
  finally { client.release(); await pool.end() }
}
main().catch(error=>{console.error(error.message);process.exitCode=1})
