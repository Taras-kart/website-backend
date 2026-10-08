const clean = value => String(value ?? '').replace(/\s+/g,' ').trim()
const fail = message => { throw Object.assign(new Error(message),{status:400}) }
const numeric = (value,name,{integer=false,min=0,max=1e9}={}) => {
  const n=Number(value)
  if (!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isSafeInteger(n))) fail(`${name} is invalid`)
  return n
}
function validateVariant(body) {
  const row={...body}
  for (const field of ['name','brand','size','colour','pattern','fit','ean','image_url']) row[field]=clean(row[field])
  if (!row.name||!row.brand||!row.size||!row.colour) fail('Product name, brand, size and colour are required')
  if (row.name.length>180||row.brand.length>100||row.size.length>50||row.colour.length>80||row.pattern.length>100||row.fit.length>80) fail('One or more product fields are too long')
  row.gender=clean(row.gender).toUpperCase()
  if (!['MEN','WOMEN','KIDS'].includes(row.gender)) fail('Select Men, Women or Kids')
  row.category_id=numeric(row.category_id,'Category',{integer:true,min:1})
  row.mrp=numeric(row.mrp,'MRP',{min:0.01})
  row.sale_price=row.sale_price==null||row.sale_price===''?row.mrp:numeric(row.sale_price,'Selling price',{min:0.01,max:row.mrp})
  row.cost_price=numeric(row.cost_price||0,'Cost price')
  row.b2c_discount_pct=numeric(row.b2c_discount_pct||0,'Retail discount',{max:100})
  row.b2b_discount_pct=numeric(row.b2b_discount_pct||0,'Wholesale discount',{max:100})
  row.quantity=numeric(row.quantity,'Quantity',{integer:true})
  row.pack_size=numeric(row.pack_size||1,'Pack size',{integer:true,min:1,max:1000})
  if (row.ean&&!/^[A-Za-z0-9._-]{3,64}$/.test(row.ean)) fail('Barcode must contain 3 to 64 letters, numbers, dots, underscores or hyphens')
  if (row.image_url&&!/^https:\/\//i.test(row.image_url)&&!/^\/images\//.test(row.image_url)) fail('Image URL must use HTTPS or start with /images/')
  return row
}
async function saveVariant(db,input,branchId,user,{reference='MANUAL'}={}) {
  const row=validateVariant(input)
  const category=await db.query('SELECT id,parent_id,gender,is_active FROM product_categories WHERE id=$1',[row.category_id])
  if (!category.rows[0]?.is_active||!category.rows[0]?.parent_id||category.rows[0].gender!==row.gender) fail('Select an active category within the selected gender')
  const branch=await db.query('SELECT id FROM branches WHERE id=$1 AND is_active=TRUE',[branchId])
  if (!branch.rows.length) fail('Select an active branch')
  const identity=[row.brand.toLowerCase(),row.name.toLowerCase(),row.pattern.toLowerCase(),row.gender,row.category_id].join('|')
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[identity])
  let product=(await db.query(`SELECT id,category_id FROM products WHERE lower(trim(name))=lower($1) AND lower(trim(brand_name))=lower($2) AND lower(trim(COALESCE(pattern_code,'')))=lower($3) AND gender::text=$4 ORDER BY id LIMIT 1 FOR UPDATE`,[row.name,row.brand,row.pattern,row.gender])).rows[0]
  if (product&&Number(product.category_id)!==row.category_id) fail('This style already belongs to another category. Use a different style code or ask a super admin to correct its category.')
  if (!product) product=(await db.query(`INSERT INTO products(name,brand_name,pattern_code,fit_type,gender,category_id,is_active) VALUES($1,$2,$3,$4,$5,$6,TRUE) RETURNING id`,[row.name,row.brand,row.pattern,row.fit,row.gender,row.category_id])).rows[0]
  else await db.query('UPDATE products SET is_active=TRUE,deleted_at=NULL,updated_at=now() WHERE id=$1',[product.id])
  let variant=(await db.query(`SELECT * FROM product_variants WHERE product_id=$1 AND lower(trim(size))=lower($2) AND lower(trim(colour))=lower($3) AND lower(trim(COALESCE(fit,'')))=lower($4) ORDER BY id LIMIT 1 FOR UPDATE`,[product.id,row.size,row.colour,row.fit])).rows[0]
  if (variant&&Number(variant.pack_size||1)!==row.pack_size) fail('Existing variant has a different pack size. Create a distinct style code.')
  if (variant && user.role!=='SUPER_ADMIN') {
    const shared=await db.query('SELECT 1 FROM branch_variant_stock WHERE variant_id=$1 AND branch_id<>$2 LIMIT 1',[variant.id,branchId])
    if (shared.rows.length&&['mrp','sale_price','cost_price','b2c_discount_pct','b2b_discount_pct'].some(field=>Number(variant[field]||0)!==row[field])) fail('Prices for a shared variant can only be changed by a super admin')
  }
  if (!variant) variant=(await db.query(`INSERT INTO product_variants(product_id,size,colour,fit,pack_size,mrp,sale_price,cost_price,b2c_discount_pct,b2b_discount_pct,image_url,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE) RETURNING *`,[product.id,row.size,row.colour,row.fit,row.pack_size,row.mrp,row.sale_price,row.cost_price,row.b2c_discount_pct,row.b2b_discount_pct,row.image_url||null])).rows[0]
  else await db.query(`UPDATE product_variants SET mrp=$2,sale_price=$3,cost_price=$4,b2c_discount_pct=$5,b2b_discount_pct=$6,image_url=COALESCE(NULLIF($7,''),image_url),is_active=TRUE WHERE id=$1`,[variant.id,row.mrp,row.sale_price,row.cost_price,row.b2c_discount_pct,row.b2b_discount_pct,row.image_url])
  if (row.ean) {
    const barcode=await db.query(`INSERT INTO barcodes(variant_id,ean_code) VALUES($1,$2) ON CONFLICT(ean_code) DO UPDATE SET ean_code=EXCLUDED.ean_code WHERE barcodes.variant_id=EXCLUDED.variant_id RETURNING id`,[variant.id,row.ean])
    if (!barcode.rows.length) fail('This barcode belongs to a different variant. Correct the barcode before importing.')
  }
  const stock=(await db.query(`INSERT INTO branch_variant_stock(branch_id,variant_id,on_hand,reserved,is_active) VALUES($1,$2,$3,0,TRUE) ON CONFLICT(branch_id,variant_id) DO UPDATE SET on_hand=branch_variant_stock.on_hand+EXCLUDED.on_hand,is_active=TRUE RETURNING on_hand`,[branchId,variant.id,row.quantity])).rows[0]
  await db.query(`INSERT INTO tara_stock_movements(branch_id,variant_id,delta,balance,reason,user_id,reference) VALUES($1,$2,$3,$4,'STOCK_RECEIVED',$5,$6)`,[branchId,variant.id,row.quantity,stock.on_hand,user.id,reference])
  return {variant_id:variant.id,product_id:product.id,on_hand:stock.on_hand}
}
module.exports={validateVariant,saveVariant,numeric,clean,fail}
