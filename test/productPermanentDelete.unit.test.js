const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteProductPermanently } = require('../services/productPermanentDelete');

function makeDb({sale=false,shared=false,reserved=false,ids=[7],stockMovements=[]}={}) {
  const queries=[];
  const db={
    queries,
    async query(sql,params=[]) {
      queries.push({sql,params});
      if(sql.includes('SELECT product_id FROM product_variants WHERE id=')) return {rows:[{product_id:3}]};
      if(sql.includes('SELECT id, name, brand_name FROM products')) return {rows:[{id:3,name:'Dress',brand_name:'CHARAK'}]};
      if(sql.includes('SELECT id FROM product_variants WHERE product_id=')) return {rows:ids.map(id=>({id}))};
      if(sql.includes('SELECT branch_id,variant_id,on_hand,reserved')) return {rows:ids.map(id=>({branch_id:shared?4:3,variant_id:id,on_hand:3,reserved:reserved?1:0}))};
      if(sql.includes('AS child_table')) return {rows:[]};
      if(sql.includes('SELECT ean_code FROM barcodes')) return {rows:[{ean_code:'ABC123'}]};
      if(sql.includes('SELECT 1 FROM sale_items')) return {rows:sale?[{exists:true}]:[]};
      if(sql.includes('AS movements')) return {rows:[{movements:stockMovements}]};
      if(sql.includes('DELETE FROM products')) return {rows:[{id:3}],rowCount:1};
      return {rows:[],rowCount:1};
    }
  };
  return db;
}
const branchUser={id:8,role:'BRANCH3',branch_id:3};

test('variant deletion hard-deletes last SKU and parent and archives history',async()=>{
  const db=makeDb({stockMovements:[{id:31,variant_id:7,delta:3}]});
  const result=await deleteProductPermanently(db,{variantId:7,user:branchUser,branchId:3});
  assert.equal(result.removal_method,'permanent_database_delete');
  assert.equal(result.deleted_product,true);
  assert.equal(result.deleted_variants,1);
  assert.equal(result.archived_movements,1);
  const sqls=db.queries.map(x=>x.sql).join('\n');
  for(const table of ['barcodes','branch_variant_stock','tara_stock_movements','product_variants','products','tarascart','taraswishlist']) assert(sqls.includes(`DELETE FROM ${table}`),table);
  const log=db.queries.find(x=>x.sql.includes('INSERT INTO tara_audit_log'));
  assert(log);
  assert.equal(JSON.parse(log.params[3]).archived_stock_movements.length,1);
});

test('variant deletion preserves parent when another SKU exists',async()=>{
  const db=makeDb({ids:[7,8]});
  const result=await deleteProductPermanently(db,{variantId:7,user:branchUser,branchId:3});
  assert.equal(result.deleted_product,false);
  assert.equal(result.deleted_variants,1);
  assert(!db.queries.some(x=>x.sql.includes('DELETE FROM products')));
  assert(!db.queries.some(x=>x.sql.includes('DELETE FROM tarascart')));
});

test('entire product deletes all its variants as a unit',async()=>{
  const db=makeDb({ids:[7,8]});
  const result=await deleteProductPermanently(db,{productId:3,user:branchUser,branchId:3});
  assert.equal(result.deleted_product,true);
  assert.equal(result.deleted_variants,2);
  const variantsDelete=db.queries.find(x=>x.sql.includes('DELETE FROM product_variants'));
  assert.deepEqual(variantsDelete.params[0],[7,8]);
});

test('blocks sold products before destructive operations',async()=>{
  const db=makeDb({sale:true});
  await assert.rejects(deleteProductPermanently(db,{variantId:7,user:branchUser,branchId:3}),/historical sales/i);
  assert(!db.queries.some(x=>x.sql.includes('DELETE FROM product_variants')));
});

test('blocks reserved stock before destructive operations',async()=>{
  const db=makeDb({reserved:true});
  await assert.rejects(deleteProductPermanently(db,{variantId:7,user:branchUser,branchId:3}),/reservations/i);
  assert(!db.queries.some(x=>x.sql.includes('DELETE FROM product_variants')));
});

test('blocks branch user from deleting another branch inventory',async()=>{
  const db=makeDb({shared:true});
  await assert.rejects(deleteProductPermanently(db,{variantId:7,user:branchUser,branchId:3}),/not stocked in your branch/i);
  assert(!db.queries.some(x=>x.sql.includes('DELETE FROM product_variants')));
});

test('requires staff authorization',async()=>{
  const db=makeDb();
  await assert.rejects(deleteProductPermanently(db,{variantId:7,user:{id:1,role:'CUSTOMER'}}),/Administrator access required/i);
  assert.equal(db.queries.length,0);
});
