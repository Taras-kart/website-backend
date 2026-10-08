const express = require('express')
const pool = require('../db')
const { brands, brandSql } = require('../utils/brands')
const { styleSql, sellingSql, availableSql, joins, activeSql, categoryCte, filters, hydrate, branchId } = require('../utils/catalogue')
const router = express.Router()
const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res)).catch(next)
const cache = res => { res.removeHeader('Pragma');res.removeHeader('Expires');return res.set('Cache-Control','public, max-age=15, s-maxage=30, stale-while-revalidate=30') }
router.get('/catalogue',wrap(async(req,res) => {
  const {params,where} = filters(req.query)
  const limit = Math.max(1,Math.min(48,Number(req.query.limit)||24))
  const offset = Math.max(0,Math.floor(Number(req.query.offset)||0))
  const sorts = {'price-low':'price ASC,style_key','price-high':'price DESC,style_key',name:'name ASC,style_key',new:'newest DESC,style_key',featured:'in_stock DESC,newest DESC,style_key'}
  const query = `${categoryCte}, matched AS (SELECT ${styleSql} style_key,v.id,p.id product_id,p.name,${sellingSql('B2C')} price,${availableSql} available,v.colour,v.size ${joins} WHERE ${where}), grouped AS (SELECT style_key,MIN(name) name,MIN(price) price,MAX(id) newest,BOOL_OR(available>0) in_stock,SUM(available)::int available,(ARRAY_AGG(id ORDER BY (available>0) DESC,price,id))[1] representative_id,ARRAY_AGG(DISTINCT colour) colours,ARRAY_AGG(DISTINCT size) sizes,ARRAY_AGG(DISTINCT product_id) product_ids FROM matched GROUP BY style_key) SELECT *,COUNT(*) OVER()::int total FROM grouped ORDER BY ${sorts[req.query.sort]||sorts.featured} LIMIT $${params.length+1} OFFSET $${params.length+2}`
  const grouped = (await pool.query(query,[...params,limit,offset])).rows
  const products = await hydrate(grouped.map(row=>row.representative_id))
  const map = new Map(products.map(row=>[Number(row.id),row]))
  const rows = grouped.map(group=>({...map.get(Number(group.representative_id)),style_key:group.style_key,colours:group.colours,sizes:group.sizes,productIds:group.product_ids,style_available:group.available}))
  let total = grouped[0]?.total || 0
  if (!grouped.length && offset) total = Number((await pool.query(`${categoryCte} SELECT COUNT(DISTINCT ${styleSql})::int total ${joins} WHERE ${where}`,params)).rows[0].total)
  cache(res).json({products:rows,total,offset,limit,hasMore:offset+rows.length<total})
}))
router.get('/facets',wrap(async(req,res) => {
  const {params,where} = filters({gender:req.query.gender,brand:req.query.brand})
  const rows = (await pool.query(`${categoryCte}, matched AS (SELECT p.category_id,${brandSql('p.brand_name')} brand,${styleSql} style_key ${joins} WHERE ${where}), ancestry AS (SELECT id id,id leaf_id FROM visible_categories UNION ALL SELECT c.parent_id,a.leaf_id FROM ancestry a JOIN visible_categories c ON c.id=a.id WHERE c.parent_id IS NOT NULL) SELECT c.id,c.parent_id,c.name,c.slug,c.gender,c.level,c.sort_order,COUNT(DISTINCT m.style_key)::int product_count FROM visible_categories c JOIN ancestry a ON a.id=c.id JOIN matched m ON m.category_id=a.leaf_id GROUP BY c.id,c.parent_id,c.name,c.slug,c.gender,c.level,c.sort_order ORDER BY c.sort_order,c.name`,params)).rows
  const bp = filters({gender:req.query.gender})
  const counts = (await pool.query(`${categoryCte} SELECT ${brandSql('p.brand_name')} name,COUNT(DISTINCT ${styleSql})::int count ${joins} WHERE ${bp.where} GROUP BY 1`,bp.params)).rows
  cache(res).json({brands:[...brands.map(([name])=>({name,count:counts.find(b=>b.name===name)?.count||0})),{name:'Fashion',count:counts.find(b=>b.name==='Fashion')?.count||0}],categories:rows})
}))
router.get('/:id(\\d+)/family',wrap(async(req,res) => {
  const id = Number(req.params.id)
  const keys = await pool.query(`SELECT ${styleSql} style_key FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND p.is_active=TRUE AND v.is_active=TRUE`,[id])
  if (!keys.rows.length) return res.status(404).json({message:'Product not found'})
  const ids = (await pool.query(`${categoryCte} SELECT v.id ${joins} WHERE ${activeSql} AND ${styleSql}=$3 ORDER BY v.colour,v.size,v.id`,[branchId(),null,keys.rows[0].style_key])).rows.map(row=>row.id)
  const variants = await hydrate(ids)
  const product = variants.find(row=>Number(row.id)===id)
  if (!product) return res.status(404).json({message:'Product not available'})
  cache(res).json({product,variants})
}))
module.exports = router
