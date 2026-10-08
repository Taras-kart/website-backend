const jwt=require('jsonwebtoken')
const pool=require('../db')
const {secret}=require('./auth')
async function requireCustomer(req,res,next){
  if(req.customer)return next()
  try{
    const token=String(req.headers.authorization||'').replace(/^Bearer /,'')
    const payload=jwt.verify(token,secret(),{algorithms:['HS256']})
    if(payload.role||!payload.email) return res.status(401).json({message:'Customer sign-in required'})
    const user=(await pool.query('SELECT id,email,name,mobile,type FROM userstaras WHERE id=$1 AND lower(email)=lower($2)',[payload.id,payload.email])).rows[0]
    if(!user)return res.status(401).json({message:'Please sign in again'})
    req.customer=user;next()
  }catch(e){if(e.status===503)return res.status(503).json({message:e.message});if(['JsonWebTokenError','TokenExpiredError','NotBeforeError'].includes(e.name))return res.status(401).json({message:'Please sign in again'});next(e)}
}
module.exports={requireCustomer}
