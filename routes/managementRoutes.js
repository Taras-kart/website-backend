const express=require('express')
const bcrypt=require('bcryptjs')
const pool=require('../db')
const {requireAuth,requireSuperAdmin,scopeBranch}=require('../middleware/auth')
const {saveVariant,numeric,clean,fail}=require('../services/catalogueWrite')
const router=express.Router()
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next)
const audit=(db,req,action,id,details={},branch=null)=>db.query('INSERT INTO tara_audit_log(user_id,branch_id,action,entity_id,details) VALUES($1,$2,$3,$4,$5::jsonb)',[req.user.id,branch,action,String(id),JSON.stringify(details)])
async function transaction(fn){const db=await pool.connect();try{await db.query('BEGIN');const value=await fn(db);await db.query('COMMIT');return value}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}}
const page=req=>({limit:Math.max(1,Math.min(200,Number(req.query.limit)||50)),offset:Math.max(0,Math.floor(Number(req.query.offset)||0))})
router.use(requireAuth)
router.get('/branches',wrap(async(req,res)=>{
  const rows=(await pool.query(`SELECT id,name,code,address,city,state,pincode,phone,email,is_active FROM branches WHERE ($1::bigint IS NULL OR id=$1) ORDER BY is_active DESC,name`,[req.user.role==='SUPER_ADMIN'?null:req.user.branch_id])).rows
  res.json(rows)
}))
async function writeBranch(req,res){
  const body=req.body||{}
  if(!clean(body.name)) fail('Branch name is required')
  if(body.pincode&&!/^\d{6}$/.test(body.pincode)) fail('PIN code must contain six digits')
  const values=['name','code','address','city','state','pincode','phone','email'].map(key=>clean(body[key])||null)
  const row=await transaction(async db=>{
    if(req.params.id&&body.is_active===false){const open=await db.query("SELECT 1 FROM sales WHERE branch_id=$1 AND status::text NOT IN ('DELIVERED','CANCELLED','RETURNED','FAILED') LIMIT 1",[req.params.id]);const reserved=await db.query('SELECT 1 FROM branch_variant_stock WHERE branch_id=$1 AND reserved>0 LIMIT 1',[req.params.id]);if(open.rows.length||reserved.rows.length)fail('Complete open orders and reservations before deactivating this branch');await db.query("UPDATE users SET is_active=FALSE,auth_version=auth_version+1 WHERE branch_id=$1 AND role_enum::text<>'SUPER_ADMIN'",[req.params.id])}
    const result=req.params.id?await db.query(`UPDATE branches SET name=$1,code=$2,address=$3,city=$4,state=$5,pincode=$6,phone=$7,email=$8,is_active=$9,updated_at=now() WHERE id=$10 RETURNING *`,[...values,body.is_active!==false,numeric(req.params.id,'Branch',{integer:true,min:1})]):await db.query(`INSERT INTO branches(name,code,address,city,state,pincode,phone,email,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,TRUE) RETURNING *`,values)
    if(!result.rows.length) throw Object.assign(new Error('Branch not found'),{status:404})
    await audit(db,req,req.params.id?'BRANCH_UPDATED':'BRANCH_CREATED',result.rows[0].id,body,result.rows[0].id)
    return result.rows[0]
  })
  res.status(req.params.id?200:201).json(row)
}
router.post('/branches',requireSuperAdmin,wrap(writeBranch))
router.put('/branches/:id',requireSuperAdmin,wrap(writeBranch))
router.delete('/branches/:id',requireSuperAdmin,wrap(async(req,res)=>{
  const id=numeric(req.params.id,'Branch',{integer:true,min:1})
  await transaction(async db=>{
    const reserved=await db.query('SELECT 1 FROM branch_variant_stock WHERE branch_id=$1 AND reserved>0 LIMIT 1',[id])
    const orders=await db.query("SELECT 1 FROM sales WHERE branch_id=$1 AND status::text NOT IN ('DELIVERED','CANCELLED','RETURNED','FAILED') LIMIT 1",[id])
    if(reserved.rows.length||orders.rows.length) fail('Complete open orders and reservations before deactivating this branch')
    const result=await db.query('UPDATE branches SET is_active=FALSE,updated_at=now() WHERE id=$1 RETURNING id',[id])
    if(!result.rows.length) throw Object.assign(new Error('Branch not found'),{status:404})
    await db.query("UPDATE users SET is_active=FALSE,auth_version=auth_version+1 WHERE branch_id=$1 AND role_enum::text<>'SUPER_ADMIN'",[id])
    await audit(db,req,'BRANCH_DEACTIVATED',id,{},id)
  })
  res.json({message:'Branch deactivated. Sales and stock history retained.'})
}))
router.get('/admins',requireSuperAdmin,wrap(async(req,res)=>res.json((await pool.query(`SELECT u.id,u.username,u.name,u.role_enum,u.branch_id,u.is_active,u.last_login,b.name branch_name FROM users u LEFT JOIN branches b ON b.id=u.branch_id ORDER BY u.id DESC`)).rows)))
async function writeAdmin(req,res){
  const body=req.body||{}
  const username=clean(body.username).toLowerCase()
  const role=body.role_enum==='SUPER_ADMIN'?'SUPER_ADMIN':'ADMIN'
  const branch=role==='SUPER_ADMIN'?null:numeric(body.branch_id,'Branch',{integer:true,min:1})
  if(username.length<3||username.length>160) fail('Username must contain 3 to 160 characters')
  if((!req.params.id||body.password)&&String(body.password||'').length<10) fail('Use a password with at least 10 characters')
  const hash=body.password?await bcrypt.hash(body.password,12):null
  const row=await transaction(async db=>{
    await db.query('SELECT pg_advisory_xact_lock(73498102)')
    if(branch&&!(await db.query('SELECT id FROM branches WHERE id=$1 AND is_active=TRUE',[branch])).rows.length) fail('Select an active branch')
    const id=req.params.id?numeric(req.params.id,'Admin',{integer:true,min:1}):null
    if(id===Number(req.user.id)&&(body.is_active===false||role!=='SUPER_ADMIN')) fail('You cannot disable or demote your own super admin account')
    if((await db.query('SELECT 1 FROM users WHERE lower(username)=lower($1) AND ($2::bigint IS NULL OR id<>$2)',[username,id])).rows.length) fail('This username is already in use')
    const result=id?await db.query(`UPDATE users SET username=$1,name=$2,role_enum=$3,branch_id=$4,is_active=$5,hashed_pw=COALESCE($6,hashed_pw),auth_version=auth_version+1 WHERE id=$7 RETURNING id,username,name,role_enum,branch_id,is_active`,[username,clean(body.name),role,branch,body.is_active!==false,hash,id]):await db.query(`INSERT INTO users(username,name,role_enum,branch_id,hashed_pw,is_active) VALUES($1,$2,$3,$4,$5,TRUE) RETURNING id,username,name,role_enum,branch_id,is_active`,[username,clean(body.name),role,branch,hash])
    if(!result.rows.length) throw Object.assign(new Error('Admin not found'),{status:404})
    await audit(db,req,id?'ADMIN_UPDATED':'ADMIN_CREATED',result.rows[0].id,{username,role,branch_id:branch},branch)
    return result.rows[0]
  })
  res.status(req.params.id?200:201).json(row)
}
router.post('/admins',requireSuperAdmin,wrap(writeAdmin))
router.put('/admins/:id',requireSuperAdmin,wrap(writeAdmin))
router.delete('/admins/:id',requireSuperAdmin,wrap(async(req,res)=>{
  if(Number(req.params.id)===Number(req.user.id)) fail('You cannot deactivate your own account')
  await transaction(async db=>{
    const result=await db.query('UPDATE users SET is_active=FALSE,auth_version=auth_version+1 WHERE id=$1 RETURNING id',[numeric(req.params.id,'Admin',{integer:true,min:1})])
    if(!result.rows.length) throw Object.assign(new Error('Admin not found'),{status:404})
    await audit(db,req,'ADMIN_DEACTIVATED',req.params.id)
  })
  res.json({message:'Admin deactivated. Existing sessions revoked.'})
}))
router.get('/stock',wrap(async(req,res)=>{
  const branch=scopeBranch(req,false),{limit,offset}=page(req)
  const params=[branch,`%${clean(req.query.q)}%`,req.query.low==='true',limit,offset]
  const where=`($1::bigint IS NULL OR s.branch_id=$1) AND (concat_ws(' ',p.name,p.brand_name,v.size,v.colour,bc.ean_code) ILIKE $2) AND (NOT $3::boolean OR s.on_hand-s.reserved<=5)`
  const from=`FROM branch_variant_stock s JOIN branches b ON b.id=s.branch_id JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id LEFT JOIN product_categories c ON c.id=p.category_id LEFT JOIN LATERAL (SELECT ean_code FROM barcodes WHERE variant_id=v.id ORDER BY id LIMIT 1) bc ON TRUE`
  const rows=(await pool.query(`SELECT s.branch_id,b.name branch_name,v.id variant_id,p.id product_id,p.name,p.brand_name,p.gender,p.category_id,c.name category_name,p.pattern_code,v.size,v.colour,v.fit,v.pack_size,v.mrp,v.sale_price,v.b2c_discount_pct,v.b2b_discount_pct,v.image_url,bc.ean_code,s.on_hand,s.reserved,GREATEST(s.on_hand-s.reserved,0) available,s.is_active ${from} WHERE ${where} ORDER BY b.name,p.name,v.colour,v.size,v.id LIMIT $4 OFFSET $5`,params)).rows
  const total=(await pool.query(`SELECT COUNT(*)::int total ${from} WHERE ${where}`,params.slice(0,3))).rows[0].total
  res.json({rows,total,limit,offset})
}))
router.post('/products',wrap(async(req,res)=>{
  const branch=scopeBranch(req)
  const result=await transaction(async db=>{const row=await saveVariant(db,req.body,branch,req.user);await audit(db,req,'PRODUCT_RECEIVED',row.variant_id,{quantity:req.body.quantity},branch);return row})
  res.status(201).json(result)
}))
router.patch('/stock/:variantId',wrap(async(req,res)=>{
  const branch=scopeBranch(req),id=numeric(req.params.variantId,'Variant',{integer:true,min:1}),onHand=numeric(req.body.on_hand,'Stock',{integer:true}),expected=numeric(req.body.expected_on_hand,'Previous stock',{integer:true})
  if(clean(req.body.reason).length<3) fail('Enter a reason for this stock correction')
  const row=await transaction(async db=>{
    const stock=(await db.query('SELECT * FROM branch_variant_stock WHERE branch_id=$1 AND variant_id=$2 FOR UPDATE',[branch,id])).rows[0]
    if(!stock) throw Object.assign(new Error('Stock not found'),{status:404})
    if(Number(stock.on_hand)!==expected) throw Object.assign(new Error('Stock changed. Refresh and try again.'),{status:409})
    if(onHand<Number(stock.reserved)) fail('Stock cannot be lower than reserved quantity')
    await db.query('UPDATE branch_variant_stock SET on_hand=$3 WHERE branch_id=$1 AND variant_id=$2',[branch,id,onHand])
    await db.query('INSERT INTO tara_stock_movements(branch_id,variant_id,delta,balance,reason,user_id) VALUES($1,$2,$3,$4,$5,$6)',[branch,id,onHand-expected,onHand,clean(req.body.reason),req.user.id])
    await audit(db,req,'STOCK_CORRECTED',id,{before:expected,after:onHand,reason:req.body.reason},branch)
    return {on_hand:onHand}
  })
  res.json(row)
}))
router.delete('/stock/:variantId',wrap(async(req,res)=>{
  const branch=scopeBranch(req),id=numeric(req.params.variantId,'Variant',{integer:true,min:1})
  await transaction(async db=>{
    const result=await db.query('UPDATE branch_variant_stock SET is_active=FALSE WHERE branch_id=$1 AND variant_id=$2 AND reserved=0 RETURNING variant_id',[branch,id])
    if(!result.rows.length) fail('Stock not found or has an active reservation')
    await audit(db,req,'STOCK_HIDDEN',id,{},branch)
  })
  res.json({message:'Variant hidden in this branch. Stock history retained.'})
}))
router.patch('/stock/:variantId/restore',wrap(async(req,res)=>{
  const branch=scopeBranch(req)
  const result=await pool.query('UPDATE branch_variant_stock SET is_active=TRUE WHERE branch_id=$1 AND variant_id=$2 RETURNING variant_id',[branch,numeric(req.params.variantId,'Variant',{integer:true,min:1})])
  if(!result.rows.length) throw Object.assign(new Error('Stock not found'),{status:404})
  res.json(result.rows[0])
}))
function dateRange(req){
  const start=clean(req.query.start),end=clean(req.query.end)
  if((start&&!/^\d{4}-\d{2}-\d{2}$/.test(start))||(end&&!/^\d{4}-\d{2}-\d{2}$/.test(end))||(start&&end&&start>end)) fail('Select a valid date range')
  return [start?`${start}T00:00:00+05:30`:null,end?`${end}T23:59:59.999+05:30`:null]
}
router.get('/sales',wrap(async(req,res)=>{
  const {limit,offset}=page(req),params=[scopeBranch(req,false),...dateRange(req),`%${clean(req.query.q)}%`]
  const where=`($1::bigint IS NULL OR s.branch_id=$1) AND ($2::timestamptz IS NULL OR s.created_at>=$2) AND ($3::timestamptz IS NULL OR s.created_at<=$3) AND concat_ws(' ',s.id,s.customer_name,s.customer_email,s.source,s.status,s.payment_status) ILIKE $4`
  const rows=(await pool.query(`SELECT s.*,b.name branch_name FROM sales s LEFT JOIN branches b ON b.id=s.branch_id WHERE ${where} ORDER BY s.created_at DESC,s.id LIMIT $5 OFFSET $6`,[...params,limit,offset])).rows
  const total=(await pool.query(`SELECT COUNT(*)::int total FROM sales s WHERE ${where}`,params)).rows[0].total
  res.json({rows,total,limit,offset})
}))
router.patch('/sales/:id/status',wrap(async(req,res)=>{
  const status=clean(req.body.status).toUpperCase()
  const allowed={PLACED:['PROCESSING'],CONFIRMED:['PROCESSING'],PROCESSING:['SHIPPED'],SHIPPED:['DELIVERED']}
  const sale=await transaction(async db=>{
    const row=(await db.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0]
    if(!row)throw Object.assign(new Error('Order not found'),{status:404})
    if(req.user.role!=='SUPER_ADMIN'&&Number(row.branch_id)!==Number(req.user.branch_id))throw Object.assign(new Error('Order belongs to another branch'),{status:403})
    if(!allowed[row.status]?.includes(status))fail('This order cannot move to that status')
    if(!['PAID','COD'].includes(row.payment_status))fail('Confirm payment before processing this order')
    if(!['WEB'].includes(row.source))fail('Use the wholesale review flow for this order')
    await db.query('UPDATE sales SET status=$2,updated_at=now() WHERE id=$1',[row.id,status])
    await audit(db,req,'ORDER_STATUS_UPDATED',row.id,{before:row.status,after:status},row.branch_id)
    return {...row,status}
  })
  res.json(sale)
}))
router.put('/warehouses/:branchId',requireSuperAdmin,wrap(async(req,res)=>{
  const branch=numeric(req.params.branchId,'Branch',{integer:true,min:1}),body=req.body||{}
  if(!clean(body.name))fail('Enter the exact pickup location name from Shiprocket')
  const source=(await pool.query('SELECT * FROM branches WHERE id=$1 AND is_active=TRUE',[branch])).rows[0]
  if(!source)fail('Select an active branch')
  const row=await transaction(async db=>{
    const result=await db.query(`INSERT INTO shiprocket_warehouses(branch_id,warehouse_id,name,pincode,city,state,address,phone) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(branch_id) DO UPDATE SET warehouse_id=EXCLUDED.warehouse_id,name=EXCLUDED.name,pincode=EXCLUDED.pincode,city=EXCLUDED.city,state=EXCLUDED.state,address=EXCLUDED.address,phone=EXCLUDED.phone,updated_at=now() RETURNING *`,[branch,numeric(body.warehouse_id,'Pickup ID',{integer:true,min:1}),clean(body.name),source.pincode,source.city,source.state,source.address,source.phone])
    await audit(db,req,'PICKUP_UPDATED',branch,{name:clean(body.name)},branch)
    return result.rows[0]
  })
  res.json(row)
}))
router.get('/dashboard',wrap(async(req,res)=>{
  const params=[scopeBranch(req,false),...dateRange(req)]
  const sales=(await pool.query(`SELECT COUNT(*)::int orders,COUNT(*) FILTER(WHERE status::text='CANCELLED')::int cancelled,COALESCE(SUM(total) FILTER(WHERE status::text NOT IN ('CANCELLED','FAILED') AND (payment_status::text='PAID' OR (payment_status::text='COD' AND status::text='DELIVERED'))),0) revenue,COUNT(*) FILTER(WHERE status::text NOT IN ('DELIVERED','CANCELLED','FAILED','RETURNED'))::int pending FROM sales WHERE ($1::bigint IS NULL OR branch_id=$1) AND ($2::timestamptz IS NULL OR created_at>=$2) AND ($3::timestamptz IS NULL OR created_at<=$3)`,params)).rows[0]
  const stocks=(await pool.query(`SELECT COALESCE(SUM(on_hand),0)::int on_hand,COALESCE(SUM(reserved),0)::int reserved,COALESCE(SUM(GREATEST(on_hand-reserved,0)),0)::int available,COUNT(*) FILTER(WHERE on_hand-reserved<=5)::int low_stock FROM branch_variant_stock WHERE is_active=TRUE AND ($1::bigint IS NULL OR branch_id=$1)`,params.slice(0,1))).rows[0]
  const branches=(await pool.query(`SELECT b.id,b.name,b.is_active,COALESCE(st.on_hand,0) on_hand,COALESCE(st.available,0) available,COALESCE(sa.orders,0) orders,COALESCE(sa.revenue,0) revenue FROM branches b LEFT JOIN LATERAL(SELECT SUM(on_hand) on_hand,SUM(GREATEST(on_hand-reserved,0)) available FROM branch_variant_stock WHERE branch_id=b.id AND is_active=TRUE) st ON TRUE LEFT JOIN LATERAL(SELECT COUNT(*) orders,COALESCE(SUM(total) FILTER(WHERE status::text NOT IN ('CANCELLED','FAILED') AND (payment_status::text='PAID' OR (payment_status::text='COD' AND status::text='DELIVERED'))),0) revenue FROM sales WHERE branch_id=b.id AND ($2::timestamptz IS NULL OR created_at>=$2) AND ($3::timestamptz IS NULL OR created_at<=$3)) sa ON TRUE WHERE ($1::bigint IS NULL OR b.id=$1) ORDER BY b.name`,params)).rows
  const daily=(await pool.query(`SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day,COUNT(*)::int orders,COALESCE(SUM(total) FILTER(WHERE status::text NOT IN ('CANCELLED','FAILED') AND (payment_status::text='PAID' OR (payment_status::text='COD' AND status::text='DELIVERED'))),0) revenue FROM sales WHERE ($1::bigint IS NULL OR branch_id=$1) AND created_at>=COALESCE($2::timestamptz,now()-interval '30 days') AND ($3::timestamptz IS NULL OR created_at<=$3) GROUP BY 1 ORDER BY 1`,params)).rows
  res.json({sales,stocks,branches,daily})
}))
router.get('/movements',wrap(async(req,res)=>{
  const {limit,offset}=page(req)
  res.json((await pool.query(`SELECT m.*,p.name product_name,v.size,v.colour,b.name branch_name FROM tara_stock_movements m JOIN product_variants v ON v.id=m.variant_id JOIN products p ON p.id=v.product_id JOIN branches b ON b.id=m.branch_id WHERE ($1::bigint IS NULL OR m.branch_id=$1) ORDER BY m.id DESC LIMIT $2 OFFSET $3`,[scopeBranch(req,false),limit,offset])).rows)
}))
router.get('/audit',requireSuperAdmin,wrap(async(req,res)=>res.json((await pool.query('SELECT a.*,u.username FROM tara_audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200')).rows)))
router.get('/products/:id',wrap(async(req,res)=>{
  const branch=scopeBranch(req)
  const result=await pool.query(`SELECT v.*,p.name product_name,p.brand_name,p.gender,p.category_id,p.pattern_code,bc.ean_code FROM product_variants v JOIN products p ON p.id=v.product_id JOIN branch_variant_stock s ON s.variant_id=v.id AND s.branch_id=$2 LEFT JOIN LATERAL(SELECT ean_code FROM barcodes WHERE variant_id=v.id ORDER BY id LIMIT 1) bc ON TRUE WHERE v.id=$1`,[numeric(req.params.id,'Variant',{integer:true,min:1}),branch])
  if(!result.rows.length) throw Object.assign(new Error('Product not found in this branch'),{status:404})
  res.json(result.rows[0])
}))
router.put('/products/:id',wrap(async(req,res)=>{
  const branch=scopeBranch(req),id=numeric(req.params.id,'Variant',{integer:true,min:1}),row=require('../services/catalogueWrite').validateVariant({...req.body,quantity:0})
  await transaction(async db=>{
    const current=(await db.query(`SELECT v.* FROM product_variants v JOIN branch_variant_stock s ON s.variant_id=v.id WHERE v.id=$1 AND s.branch_id=$2 FOR UPDATE OF v`,[id,branch])).rows[0]
    if(!current) throw Object.assign(new Error('Product not found in this branch'),{status:404})
    if(req.user.role!=='SUPER_ADMIN'&&(await db.query('SELECT 1 FROM branch_variant_stock s JOIN product_variants v ON v.id=s.variant_id WHERE v.product_id=$1 AND s.branch_id<>$2 LIMIT 1',[current.product_id,branch])).rows.length) throw Object.assign(new Error('A super admin must edit a product shared by several branches'),{status:403})
    if(Number(current.pack_size||1)!==row.pack_size) fail('Pack size cannot change after stock is created')
    const category=(await db.query('SELECT * FROM product_categories WHERE id=$1 AND is_active=TRUE',[row.category_id])).rows[0]
    if(!category?.parent_id||category.gender!==row.gender) fail('Select a valid category within the selected department')
    await db.query('UPDATE products SET name=$2,brand_name=$3,gender=$4,category_id=$5,pattern_code=$6,updated_at=now() WHERE id=$1',[current.product_id,row.name,row.brand,row.gender,row.category_id,row.pattern])
    await db.query('UPDATE product_variants SET size=$2,colour=$3,fit=$4,mrp=$5,sale_price=$6,cost_price=$7,b2c_discount_pct=$8,b2b_discount_pct=$9,image_url=$10 WHERE id=$1',[id,row.size,row.colour,row.fit,row.mrp,row.sale_price,row.cost_price,row.b2c_discount_pct,row.b2b_discount_pct,row.image_url||null])
    if(row.ean){const barcode=await db.query('INSERT INTO barcodes(variant_id,ean_code) VALUES($1,$2) ON CONFLICT(ean_code) DO UPDATE SET ean_code=EXCLUDED.ean_code WHERE barcodes.variant_id=EXCLUDED.variant_id RETURNING id',[id,row.ean]);if(!barcode.rows.length)fail('Barcode belongs to a different variant')}
    await audit(db,req,'PRODUCT_UPDATED',id,{name:row.name,mrp:row.mrp},branch)
  })
  res.json({message:'Product updated'})
}))
module.exports=router
