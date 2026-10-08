const router=require('express').Router()
const pool=require('../db')
const RazorpayService=require('../services/razorpayService')
router.post('/payments/create-order',async(req,res,next)=>{
  let db
  try{
    const id=String(req.body.sale_id||'')
    db=await pool.connect();await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`payment:${id}`])
    const sale=(await db.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE',[id])).rows[0]
    if(!sale)throw Object.assign(new Error('Order not found'),{status:404})
    if(sale.status==='CANCELLED'||sale.payment_status==='PAID'||sale.payment_method!=='ONLINE')throw Object.assign(new Error('This order is not awaiting online payment'),{status:409})
    const amount=Math.round(Number(sale.total)*100)
    if(amount<=0)throw Object.assign(new Error('Invalid payment amount'),{status:400})
    let order=(await db.query("SELECT razorpay_order_id AS id,amount_paise AS amount,currency FROM payments WHERE sale_id=$1 AND lower(status) IN ('created','attempted','pending') ORDER BY created_at DESC LIMIT 1",[id])).rows[0]
    if(!order){
      order=await new RazorpayService({}).createOrder({amountPaise:amount,currency:'INR',receipt:id,notes:{sale_id:id}})
      await db.query('INSERT INTO payments(sale_id,razorpay_order_id,status,amount_paise,currency,email,phone,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[id,order.id,order.status||'created',order.amount,order.currency,sale.customer_email,sale.customer_mobile,JSON.stringify(order.notes||{})])
    }
    await db.query('COMMIT');res.json({key_id:process.env.RAZORPAY_KEY_ID,order_id:order.id,amount:order.amount,currency:order.currency,sale_id:id})
  }catch(e){if(db)await db.query('ROLLBACK');next(e)}finally{db?.release()}
})
async function applyCaptured(orderId,paymentId,entity){
  const db=await pool.connect()
  try{
    await db.query('BEGIN')
    const payment=(await db.query('SELECT * FROM payments WHERE razorpay_order_id=$1 FOR UPDATE',[orderId])).rows[0]
    if(!payment)throw Object.assign(new Error('Payment not found'),{status:404})
    if(entity.order_id!==orderId||Number(entity.amount)!==Number(payment.amount_paise)||entity.currency!==payment.currency||entity.status!=='captured')throw Object.assign(new Error('Payment has not been captured for the expected amount'),{status:409})
    const sale=(await db.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE',[payment.sale_id])).rows[0]
    if(sale.status==='CANCELLED')throw Object.assign(new Error('Payment received for a cancelled order. Contact support for a refund.'),{status:409})
    await db.query("UPDATE payments SET razorpay_payment_id=$2,status='PAID',method=$3 WHERE razorpay_order_id=$1",[orderId,paymentId,entity.method||null])
    await db.query("UPDATE sales SET payment_status='PAID',updated_at=now() WHERE id=$1",[payment.sale_id])
    await db.query('COMMIT');return payment.sale_id
  }catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
}
router.post('/payments/verify',async(req,res,next)=>{
  try{
    const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{}
    const svc=new RazorpayService({})
    if(!razorpay_order_id||!razorpay_payment_id||!svc.verifyPaymentSignature({orderId:razorpay_order_id,paymentId:razorpay_payment_id,signature:razorpay_signature}))return res.status(400).json({ok:false,message:'Invalid payment signature'})
    const entity=await svc.fetchPayment(razorpay_payment_id)
    await applyCaptured(razorpay_order_id,razorpay_payment_id,entity)
    res.json({ok:true,status:'PAID'})
  }catch(e){next(e)}
})
router.post('/payments/mark-failed',(req,res)=>res.json({ok:true,message:'You can retry payment from your order. Cancel the order to release stock and coins.'}))
router.get('/payments/by-sale/:id',async(req,res,next)=>{
  try{res.json((await pool.query('SELECT razorpay_order_id,razorpay_payment_id,status,amount_paise,currency,method,created_at FROM payments WHERE sale_id=$1 ORDER BY created_at DESC',[req.params.id])).rows)}catch(e){next(e)}
})
router.post(['/webhook','/razorpay/webhook'],async(req,res,next)=>{
  try{
    const svc=new RazorpayService({}),raw=req.rawBody
    if(!raw||!svc.verifyWebhookSignature({bodyRaw:raw,signature:req.headers['x-razorpay-signature'],secret:process.env.RAZORPAY_WEBHOOK_SECRET}))return res.status(400).json({message:'Invalid signature'})
    const entity=req.body?.payload?.payment?.entity
    if(req.body.event==='payment.captured'&&entity?.order_id)await applyCaptured(entity.order_id,entity.id,entity)
    res.json({ok:true})
  }catch(e){next(e)}
})
module.exports=router
