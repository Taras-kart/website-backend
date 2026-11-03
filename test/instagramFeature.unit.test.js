const test=require('node:test'),assert=require('node:assert/strict')
const {codeFor,mediaFor,captionFor,parseMoney,insertReel}=require('../services/instagramProducts')
const fs=require('fs'),path=require('path')

test('numeric, alphanumeric and lowercase reel codes normalize',()=>{
 assert.equal(codeFor('000123'),'000123')
 assert.equal(codeFor(' reel-100_a '),'REEL-100_A')
})
test('invalid codes are refused',()=>{
 for(const value of ['A','a b c','@#AB','hello/23','😀123','a'.repeat(33)])assert.throws(()=>codeFor(value))
})
test('video links require HTTPS; captions bounded',()=>{
 assert.equal(mediaFor(''),null)
 assert.equal(mediaFor('https://www.instagram.com/reel/C1/'),'https://www.instagram.com/reel/C1/')
 assert.throws(()=>mediaFor('javascript:alert(1)'))
 assert.throws(()=>mediaFor('http://example.com/video.mp4'))
 assert.throws(()=>captionFor('x'.repeat(501)))
})
test('duplicate code is rejected before stock changes',async()=>{
 let calls=0
 const db={query:async(sql)=>{calls++;assert.match(sql,/SELECT 1 FROM instagram_products/);return{rows:[{exists:true}]}}}
 await assert.rejects(()=>insertReel(db,{code:'REEL-123'},1,{id:1,role:'SUPER_ADMIN'}),/already exists/i)
 assert.equal(calls,1)
})
test('new Reel receives stock through original catalogue service and attaches a code',async()=>{
 const calls=[]
 const db={query:async(sql,params=[])=>{
  calls.push({sql,params})
  if(sql.includes('SELECT 1 FROM instagram_products'))return{rows:[]}
  if(sql.includes('FROM product_categories'))return{rows:[{id:57,is_active:true,parent_id:12,gender:'WOMEN'}]}
  if(sql.includes('FROM branches'))return{rows:[{id:1}]}
  if(sql.includes('FROM products WHERE'))return{rows:[]}
  if(sql.includes('INSERT INTO products('))return{rows:[{id:10}]}
  if(sql.includes('FROM product_variants WHERE'))return{rows:[]}
  if(sql.includes('INSERT INTO product_variants('))return{rows:[{id:20}]}
  if(sql.includes('INSERT INTO barcodes('))return{rows:[{id:30}]}
  if(sql.includes('INSERT INTO branch_variant_stock('))return{rows:[{on_hand:5}]}
  if(sql.includes('INSERT INTO instagram_products('))return{rows:[{code:params[0],variant_id:params[1],branch_id:params[2],is_published:params[5]}]}
  return{rows:[]}
 }}
 const result=await insertReel(db,{code:'00123',name:'Cotton dress',brand:'Demo',gender:'WOMEN',category_id:57,colour:'Pink',size:'M',mrp:999,quantity:5},1,{id:1,role:'SUPER_ADMIN'})
 assert.equal(result.variant_id,20)
 assert.equal(result.on_hand,5)
 assert.equal(result.code,'00123')
 assert.equal(calls.find(x=>x.sql.includes('INSERT INTO barcodes')).params[1],'IG-00123')
 assert.equal(calls.filter(x=>x.sql.includes('INSERT INTO branch_variant_stock')).length,1)
})
test('global catalogue search supports exact reel code without replacing normal search',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../utils/catalogue.js'),'utf8')
 assert.match(source,/EXISTS \(SELECT 1 FROM instagram_products/)
 assert.match(source,/ig.is_published=TRUE/)
})

test('Excel MRP imports correctly when price exceeds 999',()=>{
 assert.equal(parseMoney(1099),1099)
 assert.equal(parseMoney('1,099'),1099)
 assert.equal(parseMoney('₹ 1,099.00'),1099)
 assert.equal(parseMoney('Rs. 1,50,000'),150000)
 assert.equal(parseMoney('1,20,500.50'),120500.50)
 assert.equal(parseMoney('', 'Selling price', true),'')
 for(const item of ['1,09,9','₹ abc','1,2,3',-1/0])assert.throws(()=>parseMoney(item),/invalid/i)
})
test('code matching and uploads have server-side safeguards',()=>{
 const route=fs.readFileSync(path.join(__dirname,'../routes/instagramProductRoutes.js'),'utf8')
 assert.match(route,/raw:true,blankrows:false/)
 assert.match(route,/router\.post\('\/images\/precheck'/)
 assert.match(route,/router\.post\('\/images\/assign'/)
 assert.match(route,/ON CONFLICT\(ean_code,image_type\)/)
 assert.match(route,/router\.use\(requireAuth\)/)
})
