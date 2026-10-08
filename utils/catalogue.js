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
const categoryCte = `WITH RECURSIVE visible_categories AS (SELECT id,parent_id,name,slug,gender,level,sort_order FROM product_categories WHERE parent_id IS NULL AND is_active=TRUE UNION ALL SELECT c.id,c.parent_id,c.name,c.slug,c.gender,c.level,c.sort_order FROM product_categories c JOIN visible_categories a ON c.parent_id=a.id WHERE c.is_active=TRUE), descendants AS (SELECT id FROM visible_categories WHERE id=$2::int UNION ALL SELECT c.id FROM visible_categories c JOIN descendants d ON c.parent_id=d.id)`
const branchId = () => Number(process.env.WEB_BRANCH_ID) || null
function filters(query = {}, type = 'B2C') {
  const params = [branchId(), Number(query.categoryId || query.category_id) || null]
  const where = [activeSql]
  const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)) }
  if (params[1]) where.push('p.category_id IN (SELECT id FROM descendants)')
  if (query.categorySlug) add('pc.slug=?', clean(query.categorySlug))
  if (query.gender) add('p.gender::text=?', clean(query.gender).toUpperCase())
  if (query.brand) add(`${brandSql('p.brand_name')}=?`, clean(query.brand))
  if (query.category && !params[1]) add('lower(pc.name)=lower(?)', clean(query.category))
  for (const word of clean(query.q).split(/\s+/).filter(Boolean).slice(0,8)) add(`concat_ws(' ',p.name,${brandSql('p.brand_name')},pc.name,p.pattern_code,v.colour,p.gender) ILIKE ?`, `%${word.replace(/[\\%_]/g, '\\$&')}%`)
  if (query.min !== undefined && clean(query.min)) add(`${sellingSql(type)}>=?::numeric`, Math.max(0,Number(query.min)||0))
  if (query.max !== undefined && clean(query.max)) add(`${sellingSql(type)}<=?::numeric`, Math.max(0,Number(query.max)||0))
  if (query.sale === 'true') where.push(`${sellingSql(type)}<v.mrp`)
  if (query.inStock === 'true') where.push(`${availableSql}>0`)
  if (query.excludeInnerwear === 'true') where.push(`COALESCE(pc.name,'') !~* '(bra|panty|brief|innerwear|camisole|slip)'`)
  return {params,where:where.join(' AND ')}
}
async function hydrate(ids, db = pool, branch = branchId()) {
  if (!ids.length) return []
  const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'
  const result = await db.query(`SELECT v.id,v.id variant_id,p.id product_id,p.name product_name,${brandSql('p.brand_name')} brand,p.gender,p.category_id,pc.name category_name,pc.slug category_slug,p.pattern_code,p.fit_type,v.colour color,v.size,v.fit,v.pack_size,${styleSql} style_key,v.mrp original_price_b2c,v.mrp original_price_b2b,${sellingSql('B2C')} final_price_b2c,${sellingSql('B2B')} final_price_b2b,v.mrp,v.sale_price,COALESCE(stock.on_hand,0) on_hand,COALESCE(stock.reserved,0) reserved,${availableSql} available_qty,(${availableSql}>0) in_stock,bc.ean_code,pci.image_url shared_image_url,v.image_url variant_image_url,imgs.images,COALESCE(NULLIF(pci.image_url,''),NULLIF(v.image_url,''),imgs.images->>0,CASE WHEN bc.ean_code IS NOT NULL THEN 'https://res.cloudinary.com/'||$3||'/image/upload/f_auto,q_auto,w_720/products/'||bc.ean_code END,'/images/defaults/product.svg') image_url
  ${joins}
  LEFT JOIN LATERAL (SELECT ean_code FROM barcodes WHERE variant_id=v.id ORDER BY id LIMIT 1) bc ON TRUE
  LEFT JOIN LATERAL (SELECT image_url FROM product_colour_images WHERE product_id=p.id AND lower(trim(colour))=lower(trim(v.colour)) AND lower(trim(COALESCE(fit,'')))=lower(trim(COALESCE(v.fit,''))) LIMIT 1) pci ON TRUE
  LEFT JOIN LATERAL (SELECT jsonb_agg(image_url ORDER BY CASE WHEN image_type='front' THEN 0 WHEN image_type='back' THEN 1 ELSE 2 END,uploaded_at DESC) images FROM product_images WHERE ean_code=bc.ean_code AND NULLIF(image_url,'') IS NOT NULL) imgs ON TRUE
  WHERE v.id=ANY($2::int[])`,[branch,ids,cloud])
  return result.rows
}
module.exports = { styleSql, sellingSql, availableSql, joins, activeSql, categoryCte, filters, hydrate, branchId }
