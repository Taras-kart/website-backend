const pool = require('../db')
const { brandSql } = require('./brands')
const clean = value => String(value || '').trim()
const styleSql = `tara_style_key(p.brand_name,p.name,p.pattern_code,p.gender::text,p.category_id,COALESCE(NULLIF(v.fit,''),p.fit_type,''),v.pack_size)`
const priceSql = type => `ROUND(v.mrp::numeric * (100 - LEAST(100,GREATEST(0,COALESCE(v.${type === 'B2B' ? 'b2b' : 'b2c'}_discount_pct,0)))) / 100,2)`
const sellingSql = type => `CASE WHEN COALESCE(v.${type === 'B2B' ? 'b2b' : 'b2c'}_discount_pct,0)>0 THEN ${priceSql(type)} ELSE COALESCE(NULLIF(v.sale_price,0),v.mrp) END`
const stockJoin = `LEFT JOIN LATERAL (SELECT SUM(s.on_hand)::int on_hand,SUM(s.reserved)::int reserved FROM branch_variant_stock s JOIN branches b ON b.id=s.branch_id WHERE s.variant_id=v.id AND s.is_active=TRUE AND b.is_active=TRUE AND ($1::int IS NULL OR s.branch_id=$1)) stock ON TRUE`
const joins = `FROM products p JOIN product_variants v ON v.product_id=p.id LEFT JOIN product_categories pc ON pc.id=p.category_id ${stockJoin}`
const availableSql = `GREATEST(COALESCE(stock.on_hand,0)-COALESCE(stock.reserved,0),0)`
const activeSql = `p.is_active=TRUE AND v.is_active=TRUE AND (p.category_id IS NULL OR p.category_id IN (SELECT id FROM visible_categories))`
const categoryCte = `WITH RECURSIVE visible_categories AS (SELECT id,parent_id,name,slug,gender,level,sort_order FROM product_categories WHERE parent_id IS NULL AND is_active=TRUE UNION ALL SELECT c.id,c.parent_id,c.name,c.slug,c.gender,c.level,c.sort_order FROM product_categories c JOIN visible_categories a ON c.parent_id=a.id WHERE c.is_active=TRUE), descendants AS (SELECT id FROM visible_categories WHERE id=ANY($2::int[]) UNION ALL SELECT c.id FROM visible_categories c JOIN descendants d ON c.parent_id=d.id)`
const branchId = () => Number(process.env.WEB_BRANCH_ID) || null
function filters(query = {}, type = 'B2C') {
  const values=value=>[...new Set((Array.isArray(value)?value:[value]).flatMap(v=>String(v||'').split(',')).map(clean).filter(Boolean))]
  const categoryIds=values(query.categoryId||query.category_id).map(Number).filter(v=>Number.isSafeInteger(v)&&v>0)
  const params = [branchId(), categoryIds.length?categoryIds:null]
  const where = [activeSql]
  const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)) }
  if (params[1]) where.push('p.category_id IN (SELECT id FROM descendants)')
  if (query.categorySlug&&!params[1]) add('p.category_id IN (WITH RECURSIVE selected AS (SELECT id FROM visible_categories WHERE slug=? UNION ALL SELECT c.id FROM visible_categories c JOIN selected s ON c.parent_id=s.id) SELECT id FROM selected)',clean(query.categorySlug))
  if (query.gender) add('p.gender::text=ANY(?::text[])',values(query.gender).map(v=>v.toUpperCase()))
  if (query.brand) add(`${brandSql('p.brand_name')}=ANY(?::text[])`,values(query.brand))
  if (query.category && !params[1]) add('lower(pc.name)=lower(?)', clean(query.category))
  for (const word of clean(query.q).split(/\s+/).filter(Boolean).slice(0,8)) add(`concat_ws(' ',p.name,${brandSql('p.brand_name')},pc.name,p.pattern_code,v.colour,p.gender) ILIKE ?`, `%${word.replace(/[\\%_]/g, '\\$&')}%`)
  if (query.min !== undefined && clean(query.min)) add(`${sellingSql(type)}>=?::numeric`, Math.max(0,Number(query.min)||0))
  if (query.max !== undefined && clean(query.max)) add(`${sellingSql(type)}<=?::numeric`, Math.max(0,Number(query.max)||0))
  if (query.sale === 'true') where.push(`${sellingSql(type)}<v.mrp`)
  if (query.inStock === 'true') where.push(`${availableSql}>0`)
  if (query.excludeInnerwear === 'true') where.push(`COALESCE(pc.name,'') !~* '(bra|panty|brief|innerwear|camisole|slip)'`)
  return {params,where:where.join(' AND ')}
}
const validImage = column => `NULLIF(BTRIM(${column}),'') IS NOT NULL AND ${column} !~ '(defaults/|placeholder|coming-soon)'`
const fitValue = alias => `lower(trim(COALESCE(NULLIF(${alias}.fit,''),p.fit_type,'')))`
const sharedMatch = `i.product_id=p.id AND lower(trim(i.colour))=lower(trim(v.colour)) AND lower(trim(COALESCE(i.fit,''))) IN ('',${fitValue('v')})`
const variantMatch = `iv.product_id=p.id AND iv.is_active=TRUE AND lower(trim(iv.colour))=lower(trim(v.colour)) AND ${fitValue('iv')}=${fitValue('v')}`
const hasImageSql = `((${validImage('v.image_url')}) OR EXISTS(SELECT 1 FROM product_colour_images i WHERE ${sharedMatch} AND ${validImage('i.image_url')}) OR EXISTS(SELECT 1 FROM product_variants iv LEFT JOIN barcodes ib ON ib.variant_id=iv.id LEFT JOIN product_images ii ON ii.ean_code=ib.ean_code WHERE ${variantMatch} AND ((${validImage('ii.image_url')}) OR (${validImage('iv.image_url')}))))`
async function hydrate(ids, db = pool, branch = branchId()) {
  if (!ids.length) return []
  const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'
  const result = await db.query(`SELECT v.id,v.id variant_id,p.id product_id,p.name product_name,${brandSql('p.brand_name')} brand,p.gender,p.category_id,pc.name category_name,pc.slug category_slug,p.pattern_code,p.fit_type,v.colour color,v.size,v.fit,v.pack_size,${styleSql} style_key,v.mrp original_price_b2c,v.mrp original_price_b2b,${sellingSql('B2C')} final_price_b2c,${sellingSql('B2B')} final_price_b2b,v.mrp,v.sale_price,COALESCE(stock.on_hand,0) on_hand,COALESCE(stock.reserved,0) reserved,${availableSql} available_qty,(${availableSql}>0) in_stock,bc.ean_code,bc.ean_codes,imgs.images,imgs.image_candidates,imgs.image_candidates->>0 image_url
  ${joins}
  LEFT JOIN LATERAL (SELECT (array_agg(ean_code ORDER BY id))[1] ean_code,array_agg(ean_code ORDER BY id) ean_codes FROM barcodes WHERE variant_id=v.id) bc ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(url ORDER BY priority,url) FILTER (WHERE priority<9) images,jsonb_agg(url ORDER BY priority,url) image_candidates FROM (
      SELECT url,MIN(priority) priority FROM (
        SELECT BTRIM(i.image_url) url,CASE WHEN lower(trim(COALESCE(i.fit,'')))=lower(trim(COALESCE(v.fit,''))) THEN 0 ELSE 1 END priority FROM product_colour_images i WHERE ${sharedMatch} AND ${validImage('i.image_url')}
        UNION ALL SELECT BTRIM(v.image_url),2 WHERE ${validImage('v.image_url')}
        UNION ALL SELECT BTRIM(ii.image_url),CASE WHEN lower(COALESCE(ii.image_type,'front'))='front' THEN 3 WHEN lower(ii.image_type)='back' THEN 5 ELSE 6 END FROM product_variants iv JOIN barcodes ib ON ib.variant_id=iv.id JOIN product_images ii ON ii.ean_code=ib.ean_code WHERE ${variantMatch} AND ${validImage('ii.image_url')}
        UNION ALL SELECT BTRIM(iv.image_url),4 FROM product_variants iv WHERE ${variantMatch} AND ${validImage('iv.image_url')}
        UNION ALL SELECT 'https://res.cloudinary.com/'||$3||'/image/upload/f_auto,q_auto/products/'||ib.ean_code,9 FROM barcodes ib JOIN product_variants iv ON iv.id=ib.variant_id WHERE ${variantMatch} AND NULLIF(BTRIM(ib.ean_code),'') IS NOT NULL
      ) candidates GROUP BY url
    ) deduplicated
  ) imgs ON TRUE
  WHERE v.id=ANY($2::int[])`,[branch,ids,cloud])
  return result.rows
}
module.exports = { styleSql, sellingSql, availableSql, joins, activeSql, categoryCte, filters, hydrate, branchId, hasImageSql }
