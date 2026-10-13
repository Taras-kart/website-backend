const router=require('express').Router()
const pool=require('../db')
const {requireAuth,requireSuperAdmin}=require('../middleware/auth')
router.post('/web/b2b-update-status',requireAuth,requireSuperAdmin,async(req,res,next)=>{
  let db
  const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})}
  try{
    const {sale_id,new_status,new_payment_status}=req.body||{}
    if(!sale_id)fail('Order reference required')
    db=await pool.connect();await db.query('BEGIN')
    const sale=(await db.query("SELECT * FROM sales WHERE id=$1 AND source='B2B' FOR UPDATE",[sale_id])).rows[0]
    if(!sale)fail('Wholesale order not found',404)
    const status=new_status||sale.status,payment=new_payment_status||sale.payment_status
    if(status===sale.status&&payment===sale.payment_status){await db.query('COMMIT');return res.json({id:sale.id,status,payment_status:payment})}
    const approved=sale.status==='B2B_PENDING'&&status==='APPROVED'&&payment==='PENDING'
    const declined=sale.status==='B2B_PENDING'&&status==='CANCELLED'&&payment==='FAILED'
    const paid=sale.status==='APPROVED'&&status==='APPROVED'&&sale.payment_status==='PENDING'&&payment==='PAID'
    const dispatched=sale.status==='APPROVED'&&status==='DISPATCHED'&&sale.payment_status==='PAID'&&payment==='PAID'
    const delivered=sale.status==='DISPATCHED'&&status==='DELIVERED'&&payment==='PAID'
    if(![approved,declined,paid,dispatched,delivered].some(Boolean))fail('This wholesale status transition is not allowed')
    if(approved&&!sale.stock_committed){
      const items=(await db.query('SELECT b2b_product_id,SUM(qty)::int qty FROM sale_items WHERE sale_id=$1 GROUP BY b2b_product_id ORDER BY b2b_product_id',[sale.id])).rows
      if(!items.length||items.some(item=>!item.b2b_product_id))fail('This legacy wholesale order needs its product references reviewed before approval')
      for(const item of items){
        const stock=await db.query('UPDATE b2b_products SET stock_qty=stock_qty-$2,updated_at=now() WHERE id=$1 AND is_active=TRUE AND stock_qty>=$2 RETURNING id',[item.b2b_product_id,item.qty])
        if(!stock.rows.length)fail('Insufficient wholesale stock. Review the order quantities.',409)
        await db.query("INSERT INTO b2b_stock_movements(product_id,delta,reason,admin_user) VALUES($1,$2,$3,$4)",[item.b2b_product_id,-item.qty,`ORDER:${sale.id}`,req.user.username||String(req.user.id)])
      }
    }
    const result=(await db.query('UPDATE sales SET status=$2,payment_status=$3,stock_committed=CASE WHEN $4 THEN TRUE ELSE stock_committed END,updated_at=now() WHERE id=$1 RETURNING id,status,payment_status',[sale.id,status,payment,approved])).rows[0]
    await db.query("INSERT INTO tara_audit_log(user_id,branch_id,action,entity_id,details) VALUES($1,$2,'WHOLESALE_STATUS',$3,$4::jsonb)",[req.user.id,sale.branch_id,sale.id,JSON.stringify({status,payment})])
    await db.query('COMMIT');res.json(result)
  }catch(error){if(db)await db.query('ROLLBACK');next(error)}finally{db?.release()}
})
module.exports=router
