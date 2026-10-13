const express=require('express')
const pool=require('../db')
const {requireAuth,requireSuperAdmin,scopeBranch}=require('./auth')
const router=express.Router()
const staffPrefixes=['/barcodes','/manage','/branch','/inventory','/sales/confirm','/sales/admin','/sales/web/b2b-update-status','/b2b/stock','/b2b/import','/returns/admin']
const globalPrefixes=['/auth/branch-admins','/auth-branch/branch-admins','/shiprocket/warehouses','/b2b/stock','/b2b/import']
router.use(async(req,res,next)=>{
  const p=req.path,write=!['GET','HEAD','OPTIONS'].includes(req.method)
  const staff=staffPrefixes.some(prefix=>p===prefix||p.startsWith(prefix+'/')) || (write&&/^\/products\//.test(p)) || (write&&p.startsWith('/categories')) || p.startsWith('/categories/admin') || (write&&p.startsWith('/homepage-images')) || p==='/upload' || (req.method==='GET'&&['/b2b-customers','/b2c-customers','/sales/web'].includes(p)) || (write&&p==='/b2b-customers') || /^\/returns\/[^/]+\/(approve|reject|refund-complete)$/.test(p) || (p.startsWith('/shiprocket/')&&!p.includes('webhook')&&!p.includes('/pincode')&&!p.includes('/my-orders')&&!p.includes('/track/')) || globalPrefixes.some(prefix=>p.startsWith(prefix))
  if(!staff) return next()
  requireAuth(req,res,async error=>{
    if(error) return next(error)
    try{
      const global=globalPrefixes.some(prefix=>p.startsWith(prefix)) || (write&&p.startsWith('/categories')) || (write&&p.startsWith('/homepage-images')) || (write&&p.startsWith('/products/')) || p==='/sales/web' || (req.method==='GET'&&['/b2c-customers','/b2b-customers'].includes(p)) || (write&&p==='/b2b-customers')
      if(global&&req.user.role!=='SUPER_ADMIN') return res.status(403).json({message:'Super admin access required'})
      if(/^\/(inventory|sales\/confirm|branch)/.test(p)){
        const match=p.match(/^\/branch\/(\d+)/)
        if(match) req.params.branchId=match[1]
        scopeBranch(req)
      }
      const saleId=req.body?.sale_id||req.params?.saleId||p.match(/\/(?:by-sale|fulfill|label|invoice|manifest|serviceability|admin)\/([0-9a-f-]{36})/i)?.[1]
      if(saleId&&req.user.role!=='SUPER_ADMIN'){
        const sale=await pool.query('SELECT branch_id FROM sales WHERE id=$1',[saleId])
        if(sale.rows.length&&Number(sale.rows[0].branch_id)!==Number(req.user.branch_id)) return res.status(403).json({message:'This order belongs to another branch'})
      }
      if(/^\/returns\/[^/]+\/(approve|reject|refund-complete)$/.test(p)&&req.user.role!=='SUPER_ADMIN'){
        const id=p.split('/')[2]
        const result=await pool.query('SELECT s.branch_id FROM return_requests r JOIN sales s ON s.id=r.sale_id WHERE r.id=$1',[id])
        if(!result.rows.length||Number(result.rows[0].branch_id)!==Number(req.user.branch_id)) return res.status(403).json({message:'This return belongs to another branch'})
      }
      if(p.startsWith('/returns/admin')&&req.user.role!=='SUPER_ADMIN') return res.status(403).json({message:'Global returns review requires a super admin'})
      return next()
    }catch(e){next(e)}
  })
})
module.exports=router
