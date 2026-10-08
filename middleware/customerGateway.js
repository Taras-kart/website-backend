const router=require('express').Router()
const pool=require('../db')
const {requireCustomer}=require('./customerAuth')
router.use((req,res,next)=>{
  const p=req.path
  if(p==='/sales/web/set-payment-status')return res.status(403).json({message:'Payment status is set only by verified payment confirmation'})
  const protectedPath=/^\/(cart|wishlist|user|shipments)(\/|$)/.test(p)||/^\/coins\/(wallet|validate)$/.test(p)||/^\/sales\/web\/(place|b2b-place|by-user|[0-9a-f-]{36})$/.test(p)||p==='/orders/cancel'||p==='/orders/web/place'||p==='/shiprocket/my-orders'||(/^\/returns(\/|$)/.test(p)&&!p.startsWith('/returns/admin')&&!/\/(approve|reject|refund-complete)$/.test(p))||p.startsWith('/razorpay/payments/')||/^\/auth\/[^/]+@[^/]+$/.test(decodeURIComponent(p))
  if(!protectedPath)return next()
  const check=async()=>{
    if(req.staffVerified)return next()
    const user=req.customer
    try{
      const requested=req.body?.user_id||p.match(/^\/(?:cart|wishlist)\/(?:count\/)?(\d+)$/)?.[1]
      if(requested&&Number(requested)!==Number(user.id))return res.status(403).json({message:'This account is outside your access'})
      const email=req.query.email||req.body?.email||p.match(/^\/user\/by-email\/(.+)$/)?.[1]||p.match(/^\/auth\/([^/]+@[^/]+)$/)?.[1]
      if(email&&decodeURIComponent(email).toLowerCase()!==user.email.toLowerCase())return res.status(403).json({message:'This account is outside your access'})
      if(p==='/sales/web/b2b-place'&&user.type!=='B2B')return res.status(403).json({message:'Wholesale account required'})
      if(p==='/sales/web/by-user'){req.query.email=user.email;delete req.query.mobile}
      let saleId=req.body?.sale_id||p.match(/^\/sales\/web\/([0-9a-f-]{36})$/)?.[1]||p.match(/\/(?:by-sale|eligibility)\/([0-9a-f-]{36})$/)?.[1]
      if(p.startsWith('/razorpay/payments/')&&req.body?.razorpay_order_id){saleId=(await pool.query('SELECT sale_id FROM payments WHERE razorpay_order_id=$1',[req.body.razorpay_order_id])).rows[0]?.sale_id;if(!saleId)return res.status(404).json({message:'Payment not found'})}
      if(/^\/returns\/[^/]+(?:\/details)?$/.test(p)&&!p.endsWith('/upload-images'))saleId=(await pool.query('SELECT sale_id FROM return_requests WHERE id=$1',[p.split('/')[2]])).rows[0]?.sale_id
      if(saleId){const sale=(await pool.query('SELECT customer_email FROM sales WHERE id=$1',[saleId])).rows[0];if(!sale||sale.customer_email?.toLowerCase()!==user.email.toLowerCase())return res.status(404).json({message:'Order not found'})}
      next()
    }catch(e){next(e)}
  }
  if(req.staffVerified)return check()
  requireCustomer(req,res,error=>error?next(error):check())
})
module.exports=router
