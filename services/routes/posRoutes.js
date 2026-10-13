const express=require('express')
const crypto=require('crypto')
const pool=require('../db')
const {requireAuth,scopeBranch}=require('../middleware/auth')
const {numeric,fail}=require('../services/catalogueWrite')
const {sellingSql}=require('../utils/catalogue')
const router=express.Router()
router.post('/confirm',requireAuth,async(req,res,next)=>{
  let db
  try{
    const branch=scopeBranch(req),body=req.body||{},items=body.items
    if(!Array.isArray(items)||!items.length||items.length>200)fail('Add between 1 and 200 items')
    if(!/^[\w-]{8,100}$/.test(String(body.client_action_id||'')))fail('A valid sale reference is required')
    const method=String(body.payment?.method||'CASH').toUpperCase()
    if(!['CASH','UPI','CARD','ONLINE'].includes(method))fail('Select a valid payment method')
    const quantities=new Map()
    for(const row of items){const id=numeric(row.variant_id,'Variant',{integer:true,min:1}),qty=numeric(row.qty,'Quantity',{integer:true,min:1,max:10000});quantities.set(id,(quantities.get(id)||0)+qty)}
    const key=`POS:${req.user.id}:${body.client_action_id}`,requestHash=crypto.createHash('sha256').update(JSON.stringify({branch,method,items:[...quantities].sort((a,b)=>a[0]-b[0])})).digest('hex')
    db=await pool.connect();await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key])
    const prior=(await db.query('SELECT * FROM tara_requests WHERE key=$1',[key])).rows[0]
    if(prior){if(prior.request_hash!==requestHash)fail('Sale reference was already used for a different basket');await db.query('COMMIT');return res.json({...prior.response,idempotent:true})}
    if(!(await db.query('SELECT id FROM branches WHERE id=$1 AND is_active=TRUE',[branch])).rows.length)fail('This branch is inactive')
    const normalized=[];let total=0,bagTotal=0
    for(const [id,qty] of [...quantities].sort((a,b)=>a[0]-b[0])){
      const row=(await db.query(`SELECT v.id,v.mrp,v.size,v.colour,${sellingSql('B2C')} price FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND v.is_active=TRUE AND p.is_active=TRUE`,[id])).rows[0]
      if(!row)fail(`Variant ${id} is unavailable`)
      const stock=await db.query(`UPDATE branch_variant_stock SET on_hand=on_hand-$3 WHERE branch_id=$1 AND variant_id=$2 AND is_active=TRUE AND on_hand-reserved>=$3 RETURNING on_hand`,[branch,id,qty])
      if(!stock.rows.length)throw Object.assign(new Error(`Insufficient stock for ${row.colour} / ${row.size}`),{status:409})
      normalized.push({...row,qty,balance:stock.rows[0].on_hand});total+=Number(row.price)*qty;bagTotal+=Number(row.mrp)*qty
    }
    total=Math.round(total*100)/100
    const totals={payable:total,bagTotal,discountTotal:bagTotal-total,paymentRef:String(body.payment?.ref||'').slice(0,120)}
    const sale=(await db.query(`INSERT INTO sales(source,status,payment_status,payment_method,branch_id,total,totals,shipping_address,created_at) VALUES('POS','DELIVERED','PAID',$1,$2,$3,$4::jsonb,'{}'::jsonb,now()) RETURNING id`,[method,branch,total,JSON.stringify(totals)])).rows[0]
    for(const row of normalized){
      await db.query('INSERT INTO sale_items(sale_id,variant_id,qty,price,mrp,size,colour) VALUES($1,$2,$3,$4,$5,$6,$7)',[sale.id,row.id,row.qty,row.price,row.mrp,row.size,row.colour])
      await db.query(`INSERT INTO tara_stock_movements(branch_id,variant_id,delta,balance,reason,user_id,reference) VALUES($1,$2,$3,$4,'POS_SALE',$5,$6)`,[branch,row.id,-row.qty,row.balance,req.user.id,sale.id])
    }
    const result={ok:true,sale_id:sale.id,total,payment_method:method,items_count:normalized.length}
    await db.query('INSERT INTO tara_requests(key,user_id,branch_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)',[key,req.user.id,branch,requestHash,JSON.stringify(result)])
    await db.query('COMMIT');res.json(result)
  }catch(e){if(db)await db.query('ROLLBACK');next(e)}finally{db?.release()}
})
module.exports=router
