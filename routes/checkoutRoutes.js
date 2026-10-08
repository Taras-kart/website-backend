const router=require('express').Router()
const crypto=require('crypto')
const pool=require('../db')
const {requireCustomer}=require('../middleware/customerAuth')
const {numeric,fail}=require('../services/catalogueWrite')
const {hydrate}=require('../utils/catalogue')
const {deductCoinsForOrder}=require('../services/coinsService')
router.post('/web/place',requireCustomer,async(req,res,next)=>{
  let db
  try{
    const body=req.body||{},address=body.shipping_address||{},method=String(body.payment_method||'COD').toUpperCase()
    if(!['COD','ONLINE'].includes(method))fail('Choose cash on delivery or online payment')
    if(!String(body.customer_name||'').trim()||!/^\d{10}$/.test(String(body.customer_mobile||''))||!address.line1||!address.city||!address.state||!/^\d{6}$/.test(String(address.pincode||'')))fail('Complete the delivery name, mobile number and address')
    if(!Array.isArray(body.items)||!body.items.length||body.items.length>100)fail('A valid basket is required')
    if(!/^[\w-]{8,100}$/.test(String(body.client_action_id||'')))fail('Refresh checkout to create a valid order reference')
    const quantities=new Map()
    for(const item of body.items){const id=numeric(item.variant_id,'Variant',{integer:true,min:1}),qty=numeric(item.qty,'Quantity',{integer:true,min:1,max:1000});quantities.set(id,(quantities.get(id)||0)+qty)}
    const ids=[...quantities.keys()].sort((a,b)=>a-b),pairs=ids.map(id=>({variant_id:id,qty:quantities.get(id)}))
    const coins=numeric(body.coins_applied||0,'Coins',{integer:true})
    const key=`WEB:${req.customer.id}:${body.client_action_id}`,hash=crypto.createHash('sha256').update(JSON.stringify({pairs,method,address,coins})).digest('hex')
    db=await pool.connect();await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key])
    const prior=(await db.query('SELECT * FROM tara_requests WHERE key=$1',[key])).rows[0]
    if(prior){if(prior.request_hash!==hash)fail('This order reference belongs to another basket. Start checkout again.');await db.query('COMMIT');return res.json({...prior.response,idempotent:true})}
    const preferred=Number(process.env.WEB_BRANCH_ID)||null
    const branch=(await db.query(`WITH cart AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(variant_id int,qty int)) SELECT s.branch_id FROM branch_variant_stock s JOIN cart c ON c.variant_id=s.variant_id JOIN branches b ON b.id=s.branch_id JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE s.is_active=TRUE AND b.is_active=TRUE AND v.is_active=TRUE AND p.is_active=TRUE AND s.on_hand-s.reserved>=c.qty AND ($2::bigint IS NULL OR s.branch_id=$2) GROUP BY s.branch_id HAVING COUNT(*)=(SELECT COUNT(*) FROM cart) ORDER BY s.branch_id LIMIT 1`,[JSON.stringify(pairs),preferred])).rows[0]?.branch_id
    if(!branch)throw Object.assign(new Error('These items are not all available in one fulfilment branch. Update your bag.'),{status:409})
    const products=await hydrate(ids,db,branch)
    let bagTotal=0,subtotal=0
    for(const item of products){const qty=quantities.get(Number(item.id));bagTotal+=Number(item.mrp)*qty;subtotal+=Number(item.final_price_b2c)*qty}
    if(products.length!==ids.length)fail('One of the selected products is unavailable')
    if(coins){const settings=Object.fromEntries((await db.query('SELECT key,value FROM coin_settings')).rows.map(r=>[r.key,r.value]));if(settings.coins_enabled!=='true')fail('Coins are currently unavailable');if(coins>Math.floor(subtotal*.1))fail('Coins can cover up to 10% of the item subtotal');const wallet=(await db.query('SELECT * FROM coin_wallets WHERE user_id=$1 FOR UPDATE',[req.customer.id])).rows[0];if(!wallet||Number(wallet.balance)<coins)fail('Insufficient coins')}
    const giftWrap=body.totals?.giftWrap>0?Number(process.env.GIFT_WRAP_FEE||39):0,convenience=Number(process.env.DELIVERY_FEE||0)
    const payable=Math.round((subtotal-coins+giftWrap+convenience)*100)/100
    const totals={bagTotal:Math.round(bagTotal*100)/100,discountTotal:Math.round((bagTotal-subtotal)*100)/100,couponPct:0,couponDiscount:0,coinsApplied:coins,giftWrap,convenience,payable}
    const sale=(await db.query(`INSERT INTO sales(source,customer_email,customer_name,customer_mobile,shipping_address,status,payment_status,totals,branch_id,total,payment_method,stock_committed) VALUES('WEB',$1,$2,$3,$4::jsonb,'PLACED',$5,$6::jsonb,$7,$8,$9,TRUE) RETURNING id`,[req.customer.email,String(body.customer_name).trim(),body.customer_mobile,JSON.stringify(address),method==='COD'?'COD':'PENDING',JSON.stringify(totals),branch,payable,method])).rows[0]
    for(const id of ids){
      const item=products.find(p=>Number(p.id)===id),qty=quantities.get(id)
      const stock=await db.query('UPDATE branch_variant_stock SET on_hand=on_hand-$3 WHERE branch_id=$1 AND variant_id=$2 AND is_active=TRUE AND on_hand-reserved>=$3 RETURNING on_hand',[branch,id,qty])
      if(!stock.rows.length)throw Object.assign(new Error('Stock changed while checking out. Refresh your bag.'),{status:409})
      await db.query('INSERT INTO sale_items(sale_id,variant_id,qty,price,mrp,size,colour,image_url,ean_code,product_id,pack_size) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[sale.id,id,qty,item.final_price_b2c,item.mrp,item.size,item.color,item.image_url,item.ean_code,item.product_id,item.pack_size])
      await db.query(`INSERT INTO tara_stock_movements(branch_id,variant_id,delta,balance,reason,reference) VALUES($1,$2,$3,$4,'WEB_ORDER',$5)`,[branch,id,-qty,stock.rows[0].on_hand,sale.id])
    }
    if(coins)await deductCoinsForOrder(db,{userId:req.customer.id,coinsToDeduct:coins,saleId:sale.id})
    const result={id:sale.id,sale_id:sale.id,total:payable,totals,payment_status:method==='COD'?'COD':'PENDING'}
    await db.query('INSERT INTO tara_requests(key,user_id,branch_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)',[key,req.customer.id,branch,hash,JSON.stringify(result)])
    await db.query('DELETE FROM tarascart WHERE user_id=$1 AND product_id=ANY($2::int[])',[req.customer.id,ids])
    await db.query('COMMIT');res.status(201).json(result)
  }catch(e){if(db)await db.query('ROLLBACK');next(e)}finally{db?.release()}
})
module.exports=router
