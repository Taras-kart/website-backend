const {test}=require('node:test')
const assert=require('node:assert/strict')
const {saveVariant}=require('../services/catalogueWrite')
const row={name:'VISCOSE ANKLE LEGGING',brand:'TWIN BIRDS',pattern:'1502V',fit:'ANKLE',size:'XL',colour:'BLACK PLUS',ean:'11559642',gender:'WOMEN',category_id:39,mrp:549,sale_price:549,cost_price:0,b2c_discount_pct:0,b2b_discount_pct:0,quantity:1,pack_size:1}
const product={id:200,category_id:6}
const variant={id:300,product_id:200,fit:'ANKLE',size:'XL',colour:'BLACK PLUS',pack_size:1,mrp:549,sale_price:549,cost_price:0,b2c_discount_pct:0,b2b_discount_pct:0}
function fakeDb({shared=false}={}) {
 const calls=[]
 const db={async query(sql,params=[]){
   calls.push({sql,params})
   if(sql.includes('FROM product_categories WHERE id=$1'))return {rows:[{id:39,parent_id:6,gender:'WOMEN',is_active:true}]}
   if(sql.includes('FROM branches WHERE id=$1'))return {rows:[{id:3}]}
   if(sql.includes('FROM products WHERE lower(trim(name))'))return {rows:[product]}
   if(sql.includes('FROM product_categories c WHERE c.id=$1'))return {rows:[{name:'Ankle'}]}
   if(sql.includes('FROM product_variants pv JOIN branch_variant_stock s'))return {rows:shared?[{exists:1}]:[]}
   if(sql.includes('FROM product_variants WHERE product_id=$1'))return {rows:[variant]}
   if(sql.includes('FROM branch_variant_stock WHERE branch_id=$1'))return {rows:[{on_hand:12}]}
   if(sql.includes('INSERT INTO barcodes'))return {rows:[{id:10}]}
   if(sql.includes('INSERT INTO branch_variant_stock'))return {rows:[{on_hand:12}]}
   return {rows:[]}
 }}
 return {db,calls}
}
test('exact prior parent import can reclassify a matching style without doubling stock',async()=>{
 const {db,calls}=fakeDb()
 const result=await saveVariant(db,row,3,{id:78,role:'BRANCH3'},{reference:'IMPORT:130:4',reclassifyOnly:true})
 assert.equal(result.on_hand,12)
 assert(calls.some(q=>q.sql.startsWith('UPDATE products SET category_id=')&&q.params[0]===39))
 assert(calls.some(q=>q.sql.includes('INSERT INTO branch_variant_stock')&&q.params[2]===0))
 assert(!calls.some(q=>q.sql.includes('INSERT INTO tara_stock_movements')))
})
test('ordinary imports cannot silently recategorize an existing product',async()=>{
 const {db}=fakeDb()
 await assert.rejects(saveVariant(db,row,3,{id:78,role:'BRANCH3'}),/another category/)
})
test('reclassification cannot silently change stock/category for other branches',async()=>{
 const {db}=fakeDb({shared:true})
 await assert.rejects(saveVariant(db,row,3,{id:78,role:'BRANCH3'},{reclassifyOnly:true}),/shared-branch/)
})
