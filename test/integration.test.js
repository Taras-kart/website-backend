const {test,before,after}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const {PGlite}=require('@electric-sql/pglite')
const request=require('supertest')
const jwt=require('jsonwebtoken')
process.env.NODE_ENV='test'
process.env.JWT_SECRET='test-only-secret-never-use-in-production-123456789'
process.env.WEB_BRANCH_ID=''
process.env.DOTENV_CONFIG_PATH='/nonexistent-test-env'
for(const key of ['RAZORPAY_KEY_ID','RAZORPAY_KEY_SECRET','RAZORPAY_WEBHOOK_SECRET','CLOUDINARY_API_KEY','CLOUDINARY_API_SECRET','SHIPROCKET_EMAIL','SHIPROCKET_PASSWORD'])process.env[key]=''
let database,app,admin,superadmin,customer,variant1,variant2,webSale
const q=async(sql,args=[])=>{const result=await database.query(sql,args);return {...result,rowCount:result.affectedRows||result.rows.length}}
const pool={query:q,connect:async()=>({query:q,release(){}})}
require.cache[require.resolve('../db')]={id:require.resolve('../db'),filename:require.resolve('../db'),loaded:true,exports:pool}
const auth=token=>({Authorization:`Bearer ${token}`})
const product=(extra={})=>({name:'Shimmer leggings',brand:'Twin Birds',pattern:'SHIMMER-001',fit:'Slim',size:'M',colour:'Black',ean:'8900000000011',gender:'WOMEN',category_id:3,mrp:799,sale_price:699,cost_price:420,b2c_discount_pct:0,b2b_discount_pct:0,quantity:10,pack_size:1,branch_id:1,...extra})
before(async()=>{
 database=new PGlite();await database.exec(fs.readFileSync(path.join(__dirname,'fixture.sql'),'utf8'))
 const migration=fs.readFileSync(path.join(__dirname,'../migrations/001_catalogue_and_access.sql'),'utf8'),idx=migration.indexOf('\nBEGIN;')
 await database.exec(migration.slice(0,idx));await database.exec(migration.slice(idx))
 await database.exec("INSERT INTO branches(name) VALUES('Hyderabad'),('Vijayawada');INSERT INTO users(username,hashed_pw,role_enum,branch_id) VALUES('owner','test','SUPER_ADMIN',NULL),('branch1','test','ADMIN',1),('branch2','test','ADMIN',2);INSERT INTO product_categories(parent_id,name,slug,gender,level) VALUES(NULL,'Women','women','WOMEN',0),(1,'Leggings','leggings','WOMEN',1),(2,'Shimmer leggings','shimmer-leggings','WOMEN',2);INSERT INTO userstaras(name,email,mobile,type,password) VALUES('Test Customer','customer@example.test','9000000000','B2C','test'),('Other Customer','other@example.test','9000000001','B2C','test');INSERT INTO coin_settings VALUES('coins_enabled','true');INSERT INTO coin_wallets(user_id,balance,signup_coins_remaining) VALUES(1,100,100);")
 const {sign}=require('../middleware/auth')
 superadmin=sign((await q('SELECT * FROM users WHERE id=1')).rows[0]);admin=sign((await q('SELECT * FROM users WHERE id=2')).rows[0])
 customer=jwt.sign({id:1,email:'customer@example.test',type:'B2C'},process.env.JWT_SECRET)
 app=require('../app')
})
after(async()=>database?.close())
test('migration can be run repeatedly without losing data',async()=>{const sql=fs.readFileSync(path.join(__dirname,'../migrations/001_catalogue_and_access.sql'),'utf8'),idx=sql.indexOf('\nBEGIN;');await database.exec(sql.slice(0,idx));await database.exec(sql.slice(idx));assert.equal((await q('SELECT COUNT(*)::int n FROM branches')).rows[0].n,2)})
test('protected mutations and branch isolation reject unauthorized requests',async()=>{
 assert.equal((await request(app).post('/api/manage/products').send(product())).status,401)
 assert.equal((await request(app).get('/api/manage/stock?branch_id=2').set(auth(admin))).status,403)
 assert.equal((await request(app).get('/api/branch/2/stock').set(auth(admin))).status,403)
 assert.equal((await request(app).post('/api/categories').set(auth(admin)).send({name:'Blocked'})).status,403)
 assert.equal((await request(app).get('/api/auth/branch-admins')).status,401)
 assert.equal((await request(app).get('/api/cart/2').set(auth(customer))).status,403)
 assert.equal((await request(app).post('/api/sales/web/set-payment-status').send({status:'PAID'})).status,403)
})
test('manual product entry validates and groups sizes and colours',async()=>{
 const first=await request(app).post('/api/manage/products').set(auth(admin)).send(product());assert.equal(first.status,201,JSON.stringify(first.body));variant1=first.body.variant_id
 const second=await request(app).post('/api/manage/products').set(auth(admin)).send(product({colour:'Navy',size:'L',ean:'8900000000028'}));assert.equal(second.status,201,JSON.stringify(second.body));variant2=second.body.variant_id
 assert.equal(first.body.product_id,second.body.product_id)
 assert.equal((await request(app).post('/api/manage/products').set(auth(admin)).send(product({quantity:-5}))).status,400)
 const barcode=await request(app).post('/api/manage/products').set(auth(admin)).send(product({name:'Different style',pattern:'NEW-STYLE'}));assert.equal(barcode.status,400,JSON.stringify(barcode.body))
 assert.equal((await q("SELECT COUNT(*)::int n FROM products WHERE name='Different style'")).rows[0].n,0)
})
test('catalogue returns one card per style and detail includes every colour',async()=>{
 const list=await request(app).get('/api/products/catalogue?gender=WOMEN');assert.equal(list.status,200,JSON.stringify(list.body));assert.equal(list.body.total,1);assert.deepEqual(list.body.products[0].colours,['Black','Navy']);assert.equal(Number(list.body.products[0].style_available),20)
 const family=await request(app).get(`/api/products/${variant1}/family`);assert.equal(family.status,200,JSON.stringify(family.body));assert.equal(family.body.variants.length,2)
 const facets=await request(app).get('/api/products/facets?brand=Twin%20Birds');assert.equal(facets.status,200,JSON.stringify(facets.body));assert.equal(facets.body.categories.length,3)
 const leaf=await request(app).get('/api/products/catalogue?brand=Twin%20Birds&categoryId=3');assert.equal(leaf.body.total,1)
 const empty=await request(app).get('/api/products/catalogue?brand=Jockey&categoryId=3');assert.equal(empty.body.total,0)
})
test('unknown brands display Fashion without collapsing different source brands',async()=>{
 for(const [brand,ean] of [['Example Maker A','CUSTOM-A'],['Example Maker B','CUSTOM-B']]){const r=await request(app).post('/api/manage/products').set(auth(admin)).send(product({name:'Everyday leggings',brand,ean,pattern:''}));assert.equal(r.status,201,JSON.stringify(r.body))}
 const r=await request(app).get('/api/products/catalogue?brand=Fashion');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.total,2);assert(r.body.products.every(p=>p.brand==='Fashion'))
 const limited=await request(app).get('/api/products/catalogue?limit=1&offset=1');assert.equal(limited.body.products.length,1);assert.equal(limited.body.total,3)
})
test('POS scan never deducts stock; confirmation is atomic and retry safe',async()=>{
 const scan=await request(app).post('/api/inventory/scan').set(auth(admin)).send({branch_id:1,ean_code:'8900000000011',qty:1});assert.equal(scan.status,200,JSON.stringify(scan.body));assert.equal((await q('SELECT on_hand FROM branch_variant_stock WHERE branch_id=1 AND variant_id=$1',[variant1])).rows[0].on_hand,10)
 const body={branch_id:1,items:[{variant_id:variant1,qty:2,price:1}],payment:{method:'CASH'},client_action_id:'test-pos-sale-0001'}
 const first=await request(app).post('/api/sales/confirm').set(auth(admin)).send(body);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(Number(first.body.total),1398)
 const retry=await request(app).post('/api/sales/confirm').set(auth(admin)).send(body);assert.equal(retry.body.sale_id,first.body.sale_id);assert.equal(retry.body.idempotent,true)
 const insufficient=await request(app).post('/api/sales/confirm').set(auth(admin)).send({...body,client_action_id:'test-pos-sale-0002',items:[{variant_id:variant1,qty:1},{variant_id:variant2,qty:100}]});assert.equal(insufficient.status,409,JSON.stringify(insufficient.body));assert.equal((await q('SELECT on_hand FROM branch_variant_stock WHERE branch_id=1 AND variant_id=$1',[variant1])).rows[0].on_hand,8)
})
test('checkout ignores client price and payment status, enforces identity and idempotency',async()=>{
 const body={client_action_id:'test-web-order-0001',customer_name:'Test',customer_mobile:'9000000000',customer_email:'customer@example.test',shipping_address:{line1:'Test street',city:'Hyderabad',state:'Telangana',pincode:'500001'},payment_method:'COD',payment_status:'PAID',items:[{variant_id:variant1,qty:1,price:1}],totals:{payable:1},coins_applied:50}
 assert.equal((await request(app).post('/api/sales/web/place').send(body)).status,401)
 const first=await request(app).post('/api/sales/web/place').set(auth(customer)).send(body);assert.equal(first.status,201,JSON.stringify(first.body));assert.equal(first.body.total,649);assert.equal(first.body.payment_status,'COD');webSale=first.body.id
 const retry=await request(app).post('/api/sales/web/place').set(auth(customer)).send(body);assert.equal(retry.body.id,webSale);assert.equal(retry.body.idempotent,true)
 const other=jwt.sign({id:2,email:'other@example.test'},process.env.JWT_SECRET)
 assert.equal((await request(app).post('/api/orders/cancel').set(auth(other)).send({sale_id:webSale})).status,404)
 assert.equal((await request(app).post('/api/razorpay/payments/verify').set(auth(customer)).send({razorpay_order_id:'bad',razorpay_payment_id:'bad',razorpay_signature:'bad'})).status,404)
})
test('cancellation restores stock and coins once',async()=>{
 const first=await request(app).post('/api/orders/cancel').set(auth(customer)).send({sale_id:webSale,reason:'Test cancellation'});assert.equal(first.status,200,JSON.stringify(first.body))
 assert.equal((await q('SELECT on_hand FROM branch_variant_stock WHERE branch_id=1 AND variant_id=$1',[variant1])).rows[0].on_hand,8)
 assert.equal(Number((await q('SELECT balance FROM coin_wallets WHERE user_id=1')).rows[0].balance),100)
 assert.equal((await request(app).post('/api/orders/cancel').set(auth(customer)).send({sale_id:webSale})).status,400)
 assert.equal(Number((await q('SELECT balance FROM coin_wallets WHERE user_id=1')).rows[0].balance),100)
})
test('stock changes use optimistic locking and are isolated to a branch',async()=>{
 const result=await request(app).patch(`/api/manage/stock/${variant1}`).set(auth(admin)).send({branch_id:1,on_hand:12,expected_on_hand:8,reason:'Physical recount'});assert.equal(result.status,200,JSON.stringify(result.body))
 assert.equal((await request(app).patch(`/api/manage/stock/${variant1}`).set(auth(admin)).send({branch_id:1,on_hand:1,expected_on_hand:8,reason:'Stale tab'})).status,409)
 const dashboard=await request(app).get('/api/manage/dashboard').set(auth(admin));assert.equal(dashboard.status,200,JSON.stringify(dashboard.body));assert.equal(dashboard.body.branches.length,1);assert.equal(Number(dashboard.body.sales.revenue),1398)
 assert.equal((await request(app).get('/api/manage/sales').set(auth(admin))).status,200)
})
test('super admin creates branches and staff, deactivation revokes active sessions',async()=>{
 const branch=await request(app).post('/api/manage/branches').set(auth(superadmin)).send({name:'New branch',code:'NEW',city:'Vizag'});assert.equal(branch.status,201,JSON.stringify(branch.body))
 const staff=await request(app).post('/api/manage/admins').set(auth(superadmin)).send({username:'newadmin',name:'New admin',password:'long-test-password',branch_id:branch.body.id,role_enum:'ADMIN'});assert.equal(staff.status,201,JSON.stringify(staff.body));assert(!staff.body.hashed_pw)
 const login=await request(app).post('/api/auth-branch/login').send({username:'NEWADMIN',password:'long-test-password'});assert.equal(login.status,200,JSON.stringify(login.body))
 assert.equal((await request(app).delete(`/api/manage/admins/${staff.body.id}`).set(auth(superadmin))).status,200)
 assert.equal((await request(app).get('/api/manage/stock').set(auth(login.body.token))).status,401)
 assert.equal((await request(app).delete('/api/manage/admins/1').set(auth(superadmin))).status,400)
 assert.equal((await request(app).delete(`/api/manage/branches/${branch.body.id}`).set(auth(superadmin))).status,200)
})
test('Excel/CSV imports validate all rows and repeated processing does not double stock',async()=>{
 const csv='ProductName,BrandName,PATTERN,FITT,SIZE,COLOUR,EANCode,MRP,RSalePrice,CostPrice,B2CDiscount,B2BDiscount,PurchaseQty,PackSize\nImported leggings,Twin Birds,IMPORT-001,Slim,M,Black,IMPORT001,599,499,250,0,0,4,1\n'
 const upload=()=>request(app).post('/api/branch/1/import').set(auth(admin)).field('gender','WOMEN').field('categoryId','3').attach('file',Buffer.from(csv),'products.csv')
 const first=await upload();assert.equal(first.status,201,JSON.stringify(first.body));const id=first.body.id
 const processed=await request(app).post(`/api/branch/1/import/process/${id}`).set(auth(admin)).send({});assert.equal(processed.status,200,JSON.stringify(processed.body));assert.equal(processed.body.err,0,JSON.stringify(processed.body))
 const again=await request(app).post(`/api/branch/1/import/process/${id}`).set(auth(admin)).send({});assert.equal(again.status,200);assert.equal(again.body.processed,0)
 const dupe=await upload();assert.equal(String(dupe.body.id),String(id));assert.equal(dupe.body.reused,true)
 assert.equal((await q("SELECT s.on_hand FROM branch_variant_stock s JOIN barcodes b ON b.variant_id=s.variant_id WHERE b.ean_code='IMPORT001' AND s.branch_id=1")).rows[0].on_hand,4)
 const invalid=await request(app).post('/api/branch/1/import').set(auth(admin)).field('gender','WOMEN').field('categoryId','3').attach('file',Buffer.from(csv.replace(',4,1',',-4,1')),'bad.csv');assert.equal(invalid.status,400,JSON.stringify(invalid.body))
})
test('front and back images stay in one variant gallery and do not duplicate cart rows',async()=>{
 const confirm=await request(app).post('/api/branch/1/images/confirm').set(auth(admin)).send({images:[{ean:'8900000000011',image_type:'front',secure_url:'https://example.test/front.jpg'},{ean:'8900000000011',image_type:'back',secure_url:'https://example.test/back.jpg'}]});assert.equal(confirm.status,200,JSON.stringify(confirm.body))
 const family=await request(app).get(`/api/products/${variant1}/family`);assert.deepEqual(family.body.product.images,['https://example.test/front.jpg','https://example.test/back.jpg']);assert.equal(family.body.product.image_url,'https://example.test/front.jpg')
 await q("INSERT INTO tarascart(user_id,product_id,quantity,selected_size,selected_color) VALUES(1,$1,1,'M','Black')",[variant1])
 const cart=await request(app).get('/api/cart/1').set(auth(customer));assert.equal(cart.status,200,JSON.stringify(cart.body));assert.equal(cart.body.length,1)
})
test('delivered Excel reference imports all sample variants and preserves leading zeroes',async()=>{
 const file=path.join(__dirname,'../../../../deliverables/Tara-Product-Import-Template.xlsx')
 const packaged=path.join(__dirname,'../templates/Tara-Product-Import-Template.xlsx')
 const upload=await request(app).post('/api/branch/1/import').set(auth(admin)).field('gender','WOMEN').field('categoryId','3').attach('file',fs.existsSync(packaged)?packaged:file)
 assert.equal(upload.status,201,JSON.stringify(upload.body))
 const processed=await request(app).post(`/api/branch/1/import/process/${upload.body.id}`).set(auth(admin)).send({});assert.equal(processed.status,200,JSON.stringify(processed.body));assert.equal(processed.body.ok,4,JSON.stringify(processed.body));assert.equal(processed.body.err,0)
 const barcode=await q("SELECT ean_code FROM barcodes WHERE ean_code='0089000000011'");assert.equal(barcode.rows.length,1)
})
test('category tree and order status workflow respect staff scope',async()=>{
 const categories=await request(app).get('/api/categories/admin').set(auth(admin));assert.equal(categories.status,200,JSON.stringify(categories.body))
 const sale=(await q("INSERT INTO sales(source,status,payment_status,payment_method,branch_id,total,totals) VALUES('WEB','PLACED','COD','COD',2,100,'{\"payable\":100}') RETURNING id")).rows[0]
 assert.equal((await request(app).patch(`/api/manage/sales/${sale.id}/status`).set(auth(admin)).send({status:'PROCESSING'})).status,403)
 for(const status of ['PROCESSING','SHIPPED','DELIVERED']){const r=await request(app).patch(`/api/manage/sales/${sale.id}/status`).set(auth(superadmin)).send({status});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.status,status)}
 assert.equal((await request(app).patch(`/api/manage/sales/${sale.id}/status`).set(auth(superadmin)).send({status:'PROCESSING'})).status,400)
 const warehouse=await request(app).put('/api/manage/warehouses/2').set(auth(superadmin)).send({warehouse_id:99,name:'Vijayawada Pickup'});assert.equal(warehouse.status,200,JSON.stringify(warehouse.body))
})
test('payment verification requires the correct signature, amount and captured status',async()=>{
 const crypto=require('crypto'),Service=require('../services/razorpayService')
 process.env.RAZORPAY_KEY_SECRET='test-razorpay-secret'
 const sale=(await q("INSERT INTO sales(source,status,payment_status,payment_method,branch_id,total,totals,customer_email) VALUES('WEB','PLACED','PENDING','ONLINE',1,699,'{\"payable\":699}','customer@example.test') RETURNING id")).rows[0]
 await q("INSERT INTO payments(sale_id,razorpay_order_id,status,amount_paise,currency) VALUES($1,'order_test','created',69900,'INR')",[sale.id])
 const payload={razorpay_order_id:'order_test',razorpay_payment_id:'pay_test',razorpay_signature:'invalid'}
 assert.equal((await request(app).post('/api/razorpay/payments/verify').set(auth(customer)).send(payload)).status,400)
 payload.razorpay_signature=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update('order_test|pay_test').digest('hex')
 const original=Service.prototype.fetchPayment
 try{
 Service.prototype.fetchPayment=async()=>({order_id:'order_test',amount:1,currency:'INR',status:'captured'})
 assert.equal((await request(app).post('/api/razorpay/payments/verify').set(auth(customer)).send(payload)).status,409)
 Service.prototype.fetchPayment=async()=>({order_id:'order_test',amount:69900,currency:'INR',status:'captured',method:'upi'})
 const verified=await request(app).post('/api/razorpay/payments/verify').set(auth(customer)).send(payload);assert.equal(verified.status,200,JSON.stringify(verified.body));assert.equal(verified.body.status,'PAID')
 assert.equal((await q('SELECT payment_status FROM sales WHERE id=$1',[sale.id])).rows[0].payment_status,'PAID')
 }finally{Service.prototype.fetchPayment=original}
})
test('legacy products with separate product IDs still produce one style and full colour family',async()=>{
 const source=(await q('SELECT product_id FROM product_variants WHERE id=$1',[variant1])).rows[0].product_id
 const duplicate=(await q('INSERT INTO products(name,brand_name,pattern_code,fit_type,gender,category_id) SELECT name,brand_name,pattern_code,fit_type,gender,category_id FROM products WHERE id=$1 RETURNING id',[source])).rows[0].id
 const variant=(await q("INSERT INTO product_variants(product_id,size,colour,fit,mrp,sale_price,cost_price) VALUES($1,'XL','Wine','Slim',799,699,420) RETURNING id",[duplicate])).rows[0].id
 await q('INSERT INTO branch_variant_stock(branch_id,variant_id,on_hand) VALUES(1,$1,5)',[variant])
 const catalogue=await request(app).get('/api/products/catalogue?q=SHIMMER-001');assert.equal(catalogue.status,200);const cards=catalogue.body.products.filter(p=>p.pattern_code==='SHIMMER-001');assert.equal(cards.length,1);assert(cards[0].colours.includes('Wine'));assert.equal(cards[0].productIds.length,2)
 const family=await request(app).get(`/api/products/${variant1}/family`);assert(family.body.variants.some(v=>Number(v.id)===variant))
})
test('wholesale request preserves product identity, derives price and approves stock only once',async()=>{
 const user=(await q("INSERT INTO userstaras(name,email,mobile,type,password) VALUES('Wholesale','wholesale@example.test','9000000002','B2B','test') RETURNING id")).rows[0]
 const token=jwt.sign({id:user.id,email:'wholesale@example.test',type:'B2B'},process.env.JWT_SECRET)
 const product=(await q("INSERT INTO b2b_products(product_name,brand_name,mrp,markdown_pct,stock_qty,stock_unit,avb_sizes,colour) VALUES('Wholesale box','Example Maker',1000,20,10,'BOX','M','Black') RETURNING id")).rows[0]
 const body={client_action_id:'wholesale-order-test-0001',customer_name:'Business',customer_email:'fake@example.test',customer_mobile:'9000000002',shipping_address:{address_1:'Test street',city:'Hyderabad',state:'Telangana',pincode:'500001'},items:[{product_id:product.id,qty:2,price:1}],totals:{payable:2},payment_status:'PAID'}
 assert.equal((await request(app).post('/api/sales/web/b2b-place').set(auth(customer)).send(body)).status,403)
 const placed=await request(app).post('/api/sales/web/b2b-place').set(auth(token)).send(body);assert.equal(placed.status,201,JSON.stringify(placed.body));assert.equal(placed.body.totals.payable,1600)
 const retry=await request(app).post('/api/sales/web/b2b-place').set(auth(token)).send(body);assert.equal(retry.body.id,placed.body.id)
 const sale=(await q('SELECT * FROM sales WHERE id=$1',[placed.body.id])).rows[0];assert.equal(sale.customer_email,'wholesale@example.test');assert.equal(sale.payment_status,'PENDING')
 assert.equal(Number((await q('SELECT stock_qty FROM b2b_products WHERE id=$1',[product.id])).rows[0].stock_qty),10)
 const detail=await request(app).get(`/api/sales/admin/${sale.id}`).set(auth(superadmin));assert.equal(detail.status,200,JSON.stringify(detail.body));assert.equal(detail.body.items[0].product_name,'Wholesale box')
 const update=(status,payment)=>request(app).post('/api/sales/web/b2b-update-status').set(auth(superadmin)).send({sale_id:sale.id,new_status:status,new_payment_status:payment})
 for(let i=0;i<2;i++){const r=await update('APPROVED');assert.equal(r.status,200,JSON.stringify(r.body))}
 assert.equal(Number((await q('SELECT stock_qty FROM b2b_products WHERE id=$1',[product.id])).rows[0].stock_qty),8)
 assert.equal((await update('DISPATCHED')).status,400)
 assert.equal((await update(null,'PAID')).status,200)
 assert.equal((await update('DISPATCHED')).status,200)
 assert.equal((await update('DELIVERED')).status,200)
 assert.equal((await request(app).post('/api/sales/web/b2b-update-status').set(auth(admin)).send({sale_id:sale.id,new_status:'CANCELLED'})).status,403)
})
test('checkbox filters combine brands, departments and category subtrees accurately',async()=>{
 const read=async query=>{const r=await request(app).get('/api/products/catalogue').query(query);assert.equal(r.status,200,JSON.stringify(r.body));return r.body}
 const twin=await read({brand:'Twin Birds'}),fashion=await read({brand:'Fashion'})
 const both=await read({brand:'Twin Birds,Fashion',gender:'WOMEN,MEN',categoryId:'2,3'})
 assert.equal(both.total,twin.total+fashion.total)
 assert(both.products.every(p=>['Twin Birds','Fashion'].includes(p.brand)))
 assert.equal((await read({brand:'Twin Birds,Fashion',categorySlug:'leggings'})).total,both.total)
 assert.equal((await read({brand:'Twin Birds',gender:'MEN'})).total,0)
 const price=await read({brand:'Twin Birds,Fashion',min:'690',max:'700'})
 assert(price.products.length>0);assert(price.products.every(p=>Number(p.final_price_b2c)>=690&&Number(p.final_price_b2c)<=700))
})
test('image lookup uses alternate barcodes, same-colour sizes and generic-fit uploads without changing identity',async()=>{
 const source=(await q('SELECT product_id FROM product_variants WHERE id=$1',[variant1])).rows[0].product_id
 const sibling=(await q("INSERT INTO product_variants(product_id,size,colour,fit,mrp,image_url) VALUES($1,'XXL','Black','Slim',799,'/images/defaults/product.svg') RETURNING id",[source])).rows[0].id
 await q("INSERT INTO barcodes(variant_id,ean_code) VALUES($1,'SECOND-BARCODE')",[variant1])
 await q("INSERT INTO product_images(ean_code,image_url,image_type) VALUES('SECOND-BARCODE','https://example.test/alternate.jpg','front')")
 const {hydrate}=require('../utils/catalogue')
 let image=(await hydrate([sibling]))[0]
 assert.equal(image.ean_code,null);assert(image.images.includes('https://example.test/alternate.jpg'));assert(image.image_candidates.some(url=>url.endsWith('/products/8900000000011')))
 assert(!image.image_candidates.some(url=>url.endsWith('/products/8900000000028')))
 assert(!image.image_candidates.some(url=>url.includes('/defaults/')))
 await q("INSERT INTO product_colour_images(product_id,colour,fit,image_url) VALUES($1,' Black ','','https://example.test/generic-fit.jpg')",[source])
 image=(await hydrate([sibling]))[0];assert.equal(image.image_url,'https://example.test/generic-fit.jpg')
 const navy=(await hydrate([variant2]))[0];assert(!navy.image_candidates.includes('https://example.test/generic-fit.jpg'))
})
test('brand category images come from descendant products and stay scoped to the brand',async()=>{
 const facets=await request(app).get('/api/products/facets?brand=Twin%20Birds');assert.equal(facets.status,200,JSON.stringify(facets.body))
 for(const id of [1,2,3]){const category=facets.body.categories.find(c=>c.id===id);assert(category.images.includes('https://example.test/generic-fit.jpg'));assert(category.representative_image)}
 const fashion=await request(app).get('/api/products/facets?brand=Fashion');assert.equal(fashion.status,200);assert(fashion.body.categories.every(c=>!c.images.includes('https://example.test/generic-fit.jpg')))
 const light=await request(app).get('/api/products/facets?images=false');assert.equal(light.status,200);assert(light.body.categories.every(c=>c.images.length===0))
})
