const {test}=require('node:test');
const assert=require('node:assert/strict');
const {retireVariant}=require('../services/productRetirement');
function database({reserved=0,shared=false}={}) {
  const calls=[];
  const db={calls, async query(sql, params) {
    calls.push({sql,params});
    if (/SELECT v\.id, v\.product_id/.test(sql)) return {rows:[{id:30,product_id:40,name:'Test item',is_active:true}]};
    if (/SELECT branch_id, on_hand, reserved/.test(sql)) return {rows:[{branch_id:1,on_hand:5,reserved},...(shared?[{branch_id:2,on_hand:2,reserved:0}]:[])]};
    if (/DELETE FROM barcodes/.test(sql)) return {rows:[{ean_code:'TEST-EAN'}]};
    return {rows:[]};
  }};
  return db;
}
test('deletion releases barcode mapping and deactivates records without deleting order history',async()=>{
  const db=database();
  const row=await retireVariant(db,30,{user:{id:2,role:'ADMIN',branch_id:1},branchId:1});
  assert.equal(row.released_barcodes,1);
  assert.deepEqual(row.barcodes,['TEST-EAN']);
  assert(db.calls.some(c=>/DELETE FROM barcodes/.test(c.sql)));
  assert(db.calls.some(c=>/SET on_hand = 0, is_active = FALSE/.test(c.sql)));
  assert(db.calls.some(c=>/INSERT INTO tara_stock_movements/.test(c.sql)));
  assert(db.calls.some(c=>/UPDATE product_variants SET is_active = FALSE/.test(c.sql)));
  assert(!db.calls.some(c=>/DELETE FROM (products|product_variants|sales|sale_items|tara_stock_movements)/.test(c.sql)));
});
test('reserved stock prevents deletion before barcode mapping is changed',async()=>{
  const db=database({reserved:1});
  await assert.rejects(retireVariant(db,30,{user:{id:2,role:'ADMIN',branch_id:1},branchId:1}),{status:409});
  assert(!db.calls.some(c=>/DELETE FROM barcodes/.test(c.sql)));
});
test('branch admin cannot retire a product shared with another branch',async()=>{
  const db=database({shared:true});
  await assert.rejects(retireVariant(db,30,{user:{id:2,role:'ADMIN',branch_id:1},branchId:1}),{status:403});
  assert(!db.calls.some(c=>/DELETE FROM barcodes/.test(c.sql)));
});
test('super admin can retire shared variants in one transaction',async()=>{
  const db=database({shared:true});
  const result=await retireVariant(db,30,{user:{id:1,role:'SUPER_ADMIN'}});
  assert.equal(result.released_barcodes,1);
  assert.equal(db.calls.filter(c=>/INSERT INTO tara_stock_movements/.test(c.sql)).length,2);
});
