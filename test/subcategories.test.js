const test = require('node:test')
const assert = require('node:assert/strict')
const {matches,sqlFilter} = require('../utils/subcategories')

test('Shimmer, Viscose and Cotton leggings are separated', () => {
  const rows = [
    {name:'SHIMMER LEGGINGS'},
    {name:'VISCOSE ANKLE LEGGING'},
    {name:'COTTON LEGGINGS'}
  ]
  assert.deepEqual(rows.filter(row=>matches(row,'shimmer')).map(row=>row.name),['SHIMMER LEGGINGS'])
  assert.deepEqual(rows.filter(row=>matches(row,'viscose')).map(row=>row.name),['VISCOSE ANKLE LEGGING'])
  assert.deepEqual(rows.filter(row=>matches(row,'cotton')).map(row=>row.name),['COTTON LEGGINGS'])
})
test('Unrecognized subtype never becomes an unfiltered listing',()=>{
  assert.equal(sqlFilter('not-a-category'),'FALSE')
})
test('Non-padded bras do not match padded subtype',()=>{
  assert.equal(matches({name:'Non Padded Bra'},'padded'),false)
  assert.equal(matches({name:'Non Padded Bra'},'non-padded'),true)
})
test('Other includes styles not labeled with a subtype',()=>{
  assert.equal(matches({name:'Everyday Ankle Leggings'},'other'),true)
  assert.equal(matches({name:'Viscose Leggings'},'other'),false)
})
