const {test} = require('node:test')
const assert = require('node:assert/strict')
const {saveVariant} = require('../services/catalogueWrite')
const row = {name:'NIGHTY',brand:'CHARAK',size:'M',colour:'GREEN',pattern:'CH-ND-02',fit:'ROUND NECK',ean:'11559175',gender:'WOMEN',category_id:32,mrp:749,sale_price:749,cost_price:0,b2c_discount_pct:10,b2b_discount_pct:0,quantity:1,pack_size:1}
function mock({ category = 32, active = false } = {}) {
  const calls = []
  const query = async (sql, params = []) => {
    calls.push({sql, params})
    if (sql.includes('FROM product_categories WHERE id=$1')) return {rows:[{id:32,parent_id:4,gender:'WOMEN',is_active:true}]}
    if (sql.includes('FROM branches WHERE id=$1')) return {rows:[{id:3}]}
    if (sql.includes('FROM products WHERE lower(trim(name))')) return {rows:[{id:100,category_id:category,is_active:active}]}
    if (sql.includes('FROM product_variants WHERE product_id=$1 AND is_active=TRUE')) return {rows:[]}
    if (sql.includes('FROM product_variants WHERE product_id=$1')) return {rows:category === 32 ? [{id:201,product_id:100,pack_size:1,fit:'ROUND NECK',size:'M',colour:'GREEN',is_active:false,mrp:749,sale_price:749,cost_price:0,b2c_discount_pct:10,b2b_discount_pct:0}]:[]}
    if (sql.includes('INSERT INTO products')) return {rows:[{id:300,category_id:32,is_active:true}]}
    if (sql.includes('INSERT INTO product_variants')) return {rows:[{id:301,pack_size:1}]}
    if (sql.includes('INSERT INTO barcodes')) return {rows:[{id:501}]}
    if (sql.includes('INSERT INTO branch_variant_stock')) return {rows:[{on_hand:1}]}
    return {rows:[]}
  }
  return {db:{query},calls}
}
test('reupload reactivates retired product and variant and restores only new counted stock',async()=>{
  const {db,calls}=mock()
  const saved=await saveVariant(db,row,3,{id:78,role:'BRANCH3'})
  assert.equal(saved.product_id,100)
  assert(calls.some(c=>c.sql.includes('UPDATE products SET is_active=TRUE')))
  assert(calls.some(c=>c.sql.includes('UPDATE product_variants SET mrp=')))
  assert(calls.some(c=>c.sql.includes('INSERT INTO branch_variant_stock') && c.params[2] === 1))
})
test('retired style from another category does not force a reupload into the old category',async()=>{
  const {db,calls}=mock({category:12})
  const saved=await saveVariant(db,row,3,{id:78,role:'BRANCH3'})
  assert.equal(saved.product_id,300)
  assert(calls.some(c=>c.sql.includes('INSERT INTO products')))
  assert(!calls.some(c=>c.sql.includes('UPDATE products SET category_id=')))
})
