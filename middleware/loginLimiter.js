const crypto=require('crypto')
const pool=require('../db')
module.exports=async(req,res,next)=>{
  try{
    const identity=String(req.body?.username||req.body?.email||'').trim().toLowerCase()
    const key=crypto.createHash('sha256').update(`${req.path}:${identity}`).digest('hex')
    const row=(await pool.query("INSERT INTO tara_login_attempts(key,attempts) VALUES($1,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN tara_login_attempts.window_started<now()-interval '15 minutes' THEN 1 ELSE tara_login_attempts.attempts+1 END,window_started=CASE WHEN tara_login_attempts.window_started<now()-interval '15 minutes' THEN now() ELSE tara_login_attempts.window_started END RETURNING attempts",[key])).rows[0]
    if(row.attempts>20)return res.status(429).json({message:'Too many attempts. Try again in 15 minutes.'})
    next()
  }catch(e){next(e)}
}
