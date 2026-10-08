const jwt = require('jsonwebtoken')
const pool = require('../db')
const secret = () => {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw Object.assign(new Error('Configure JWT_SECRET with at least 32 random characters'), {status:503})
  return process.env.JWT_SECRET
}
const isStaff = role => role === 'SUPER_ADMIN' || role === 'ADMIN' || /^BRANCH\d+$/.test(role)
function sign(user) {
  return jwt.sign({id:user.id,role:user.role_enum,branch_id:user.branch_id,version:Number(user.auth_version||0)},secret(),{expiresIn:'12h',audience:'tara-staff',issuer:'tara-api'})
}
async function requireAuth(req,res,next) {
  if (req.staffVerified) return next()
  try {
    const token = String(req.headers.authorization||'').replace(/^Bearer /,'')
    const payload = jwt.verify(token,secret(),{algorithms:['HS256'],audience:'tara-staff',issuer:'tara-api'})
    const result = await pool.query(`SELECT u.id,u.username,u.role_enum,u.branch_id,u.is_active,u.auth_version,b.is_active branch_active FROM users u LEFT JOIN branches b ON b.id=u.branch_id WHERE u.id=$1`,[payload.id])
    const user = result.rows[0]
    if (!user || user.is_active===false || !isStaff(user.role_enum) || Number(user.auth_version||0)!==Number(payload.version||0)) return res.status(401).json({message:'Session expired. Please sign in again.'})
    if (user.role_enum!=='SUPER_ADMIN' && (!user.branch_id || user.branch_active!==true)) return res.status(403).json({message:'Your branch is inactive or not assigned'})
    req.user = {...user,role:user.role_enum}
    req.staffVerified = true
    next()
  } catch (error) {
    if (error.status===503) return res.status(503).json({message:error.message})
    if (['JsonWebTokenError','TokenExpiredError','NotBeforeError'].includes(error.name)) return res.status(401).json({message:'Please sign in again'})
    next(error)
  }
}
function requireSuperAdmin(req,res,next) {
  return req.user?.role==='SUPER_ADMIN' ? next() : res.status(403).json({message:'Super admin access required'})
}
function scopeBranch(req, required=true) {
  const requested = req.params.branchId || req.body?.branch_id || req.query.branch_id || req.query.branchId
  const id = requested ? Number(requested) : Number(req.user?.branch_id)||null
  if (id!==null && (!Number.isSafeInteger(id)||id<1)) throw Object.assign(new Error('Select a valid branch'),{status:400})
  if (req.user?.role!=='SUPER_ADMIN' && id!==Number(req.user?.branch_id)) throw Object.assign(new Error('This branch is outside your access'),{status:403})
  if (required&&!id) throw Object.assign(new Error('Select a branch first'),{status:400})
  return id
}
module.exports = {sign,secret,requireAuth,requireSuperAdmin,scopeBranch,isStaff}
