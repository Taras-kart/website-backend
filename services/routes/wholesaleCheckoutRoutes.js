const router=require('express').Router()
const crypto=require('crypto')
const pool=require('../db')
const {requireCustomer}=require('../middleware/customerAuth')
const {numeric,fail}=require('../services/catalogueWrite')
router.post('/web/b2b-place',requireCustomer,async(req,res,next)=>{
  let db
  try{
    if(req.customer.type!=='B2B')return res.status(403).json({message:'Wholesale account required'})
    const body=req.body||{},address=body.shipping_address||{}
    if(!String(body.customer_name||'').trim()||!/^\d{10}$/.test(String(body.customer_mobile||''))||!address.address_1||!address.city||!address.state||!/^\d{6}$/.test(String(address.pincode||'')))fail('Complete the business and delivery details')
    if(!Array.isArray(body.items)||!body.items.length||body.items.length>100)fail('A valid wholesale basket is required')
    if(!/^[\w-]{8,100}$/.test(String(body.client_action_id||'')))fail('Refresh checkout to create a valid request reference')
    const quantities=new Map()
    for(const item of body.items){const id=numeric(item.product_id||item.variant_id,'Wholesale product',{integer:true,min:1}),qty=numeric(item.qty,'Quantity',{integer:true,min:1,max:10000});quantities.set(id,(quantities.get(id)||0)+qty)}
    const ids=[...quantities.keys()].sort((a,b)=>a-b),pairs=ids.map(id=>[id,quantities.get(id)])
    const branch=body.branch_id?numeric(body.branch_id,'Branch',{integer:true,min:1}):null
    const key=`B2B:${req.customer.id}:${body.client_action_id}`,hash=crypto.createHash('sha256').update(JSON.stringify({pairs,address,branch})).digest('hex')
    db=await pool.connect();await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key])
    const prior=(await db.query('SELECT * FROM tara_requests WHERE key=$1',[key])).rows[0]
    if(prior){if(prior.request_hash!==hash)fail('This reference belongs to another basket. Start checkout again.');await db.query('COMMIT');return res.json({...prior.response,idempotent:true})}
    if(branch&&!(await db.query('SELECT id FROM branches WHERE id=$1 AND is_active=TRUE',[branch])).rows.length)fail('Choose an active branch')
    const products=(await db.query('SELECT * FROM b2b_products WHERE id=ANY($1::bigint[]) AND is_active=TRUE',[ids])).rows
    if(products.length!==ids.length)fail('A selected wholesale product is unavailable')
    let bagTotal=0,payable=0
    const items=products.map(product=>{
      const qty=quantities.get(Number(product.id)),mrp=Number(product.mrp),discount=Math.max(0,Math.min(100,Math.abs(Number(product.markdown_pct)||0))),price=Math.round(mrp*(1-discount/100)*100)/100
      if(!Number.isFinite(mrp)||mrp<=0)fail('A wholesale price needs review')
      if(qty>Number(product.stock_qty))throw Object.assign(new Error(`${product.product_name} has insufficient wholesale stock`),{status:409})
      bagTotal+=mrp*qty;payable+=price*qty
      return{...product,qty,price,mrp}
    })
    const totals={bagTotal,discountTotal:Math.round((bagTotal-payable)*100)/100,payable:Math.round(payable*100)/100,quote:true}
    const sale=(await db.query("INSERT INTO sales(source,customer_email,customer_name,customer_mobile,shipping_address,status,payment_status,payment_method,totals,total,branch_id,is_b2b,notes) VALUES('B2B',$1,$2,$3,$4::jsonb,'B2B_PENDING','PENDING','B2B_BULK',$5::jsonb,$6,$7,TRUE,$8) RETURNING id",[req.customer.email,body.customer_name,body.customer_mobile,JSON.stringify(address),JSON.stringify(totals),totals.payable,branch,String(body.notes||'').slice(0,2000)])).rows[0]
    for(const item of items)await db.query('INSERT INTO sale_items(sale_id,b2b_product_id,product_name_snapshot,brand_name_snapshot,qty,price,mrp,size,colour,pack_size) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[sale.id,item.id,item.product_name,item.brand_name,item.qty,item.price,item.mrp,item.avb_sizes,item.colour,item.stock_unit==='BOX'?Number(item.pieces_per_box)||1:1])
    const result={id:sale.id,status:'B2B_PENDING',totals}
    await db.query('INSERT INTO tara_requests(key,user_id,branch_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)',[key,req.customer.id,branch,hash,JSON.stringify(result)])
    await db.query('COMMIT');res.status(201).json(result)
  }catch(error){if(db)await db.query('ROLLBACK');next(error)}finally{db?.release()}
})
module.exports=router
