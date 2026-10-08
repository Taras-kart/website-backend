require('dotenv').config()
const {Pool}=require('pg')
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DB_SSL==='false'?false:{rejectUnauthorized:process.env.DB_SSL_REJECT_UNAUTHORIZED!=='false'},max:Number(process.env.DB_POOL_MAX)||5,idleTimeoutMillis:30000,connectionTimeoutMillis:10000})
module.exports=pool
