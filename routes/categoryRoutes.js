const express = require('express')
const pool = require('../db')

const router = express.Router()
const quote = value => `"${String(value).replace(/"/g, '""')}"`

router.get('/', async (req, res) => {
  try {
    const [categoryResult, productResult, schemaResult] = await Promise.all([
      pool.query(`SELECT id, parent_id, gender, name, slug, level, sort_order FROM product_categories WHERE is_active = TRUE ORDER BY level, sort_order, name`),
      pool.query(`SELECT id, category_id FROM products WHERE is_active = TRUE AND deleted_at IS NULL AND category_id IS NOT NULL`),
      pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('product_images', 'product_variants', 'barcodes')`)
    ])

    const categories = categoryResult.rows
    const products = productResult.rows
    const categoryById = new Map(categories.map(category => [Number(category.id), category]))
    const countSets = new Map(categories.map(category => [Number(category.id), new Set()]))
    const imageByCategory = new Map()

    const ancestorsOf = categoryId => {
      const result = []
      const visited = new Set()
      let current = categoryById.get(Number(categoryId))
      while (current && !visited.has(Number(current.id))) {
        visited.add(Number(current.id))
        result.push(Number(current.id))
        current = current.parent_id == null ? null : categoryById.get(Number(current.parent_id))
      }
      return result
    }

    products.forEach(product => {
      ancestorsOf(product.category_id).forEach(categoryId => countSets.get(categoryId)?.add(Number(product.id)))
    })

    const columns = new Map()
    schemaResult.rows.forEach(row => {
      if (!columns.has(row.table_name)) columns.set(row.table_name, new Set())
      columns.get(row.table_name).add(row.column_name)
    })

    const imageColumns = columns.get('product_images') || new Set()
    const variantColumns = columns.get('product_variants') || new Set()
    const barcodeColumns = columns.get('barcodes') || new Set()
    const firstColumn = (set, names) => names.find(name => set.has(name)) || ''
    const imageUrlColumn = firstColumn(imageColumns, ['image_url', 'url', 'secure_url', 'imageUrl'])
    const imageTypeColumn = firstColumn(imageColumns, ['image_type', 'type'])
    const imageEanColumn = firstColumn(imageColumns, ['ean_code', 'barcode', 'ean'])
    const barcodeEanColumn = firstColumn(barcodeColumns, ['ean_code', 'barcode', 'ean'])
    const imageProductColumn = firstColumn(imageColumns, ['product_id'])
    const imageVariantColumn = firstColumn(imageColumns, ['variant_id', 'product_variant_id'])
    const variantProductColumn = firstColumn(variantColumns, ['product_id'])
    const barcodeVariantColumn = firstColumn(barcodeColumns, ['variant_id', 'product_variant_id'])
    let imageRows = []

    try {
      if (imageProductColumn && imageUrlColumn) {
        const typeOrder = imageTypeColumn ? `CASE WHEN LOWER(COALESCE(pi.${quote(imageTypeColumn)}::text, '')) = 'front' THEN 0 ELSE 1 END,` : ''
        const result = await pool.query(`SELECT DISTINCT ON (p.id) p.id AS product_id, p.category_id, pi.${quote(imageUrlColumn)}::text AS image_url, NULL::text AS ean_code FROM products p JOIN product_images pi ON pi.${quote(imageProductColumn)} = p.id WHERE p.is_active = TRUE AND p.deleted_at IS NULL AND NULLIF(TRIM(pi.${quote(imageUrlColumn)}::text), '') IS NOT NULL ORDER BY p.id, ${typeOrder} p.updated_at DESC`)
        imageRows = result.rows
      } else if (variantProductColumn && imageVariantColumn && imageUrlColumn) {
        const typeOrder = imageTypeColumn ? `CASE WHEN LOWER(COALESCE(pi.${quote(imageTypeColumn)}::text, '')) = 'front' THEN 0 ELSE 1 END,` : ''
        const result = await pool.query(`SELECT DISTINCT ON (p.id) p.id AS product_id, p.category_id, pi.${quote(imageUrlColumn)}::text AS image_url, NULL::text AS ean_code FROM products p JOIN product_variants pv ON pv.${quote(variantProductColumn)} = p.id JOIN product_images pi ON pi.${quote(imageVariantColumn)} = pv.id WHERE p.is_active = TRUE AND p.deleted_at IS NULL AND NULLIF(TRIM(pi.${quote(imageUrlColumn)}::text), '') IS NOT NULL ORDER BY p.id, ${typeOrder} p.updated_at DESC`)
        imageRows = result.rows
      } else if (variantProductColumn && barcodeVariantColumn && barcodeEanColumn) {
        const imageJoin = imageEanColumn ? `LEFT JOIN product_images pi ON pi.${quote(imageEanColumn)}::text = b.${quote(barcodeEanColumn)}::text` : ''
        const imageSelect = imageUrlColumn ? `pi.${quote(imageUrlColumn)}::text` : 'NULL::text'
        const typeOrder = imageTypeColumn && imageEanColumn ? `CASE WHEN LOWER(COALESCE(pi.${quote(imageTypeColumn)}::text, '')) = 'front' THEN 0 ELSE 1 END,` : ''
        const result = await pool.query(`SELECT DISTINCT ON (p.id) p.id AS product_id, p.category_id, ${imageSelect} AS image_url, b.${quote(barcodeEanColumn)}::text AS ean_code FROM products p JOIN product_variants pv ON pv.${quote(variantProductColumn)} = p.id JOIN barcodes b ON b.${quote(barcodeVariantColumn)} = pv.id ${imageJoin} WHERE p.is_active = TRUE AND p.deleted_at IS NULL AND NULLIF(TRIM(b.${quote(barcodeEanColumn)}::text), '') IS NOT NULL ORDER BY p.id, ${typeOrder} CASE WHEN ${imageSelect} IS NOT NULL THEN 0 ELSE 1 END, p.updated_at DESC`)
        imageRows = result.rows
      }
    } catch (error) {
      imageRows = []
    }

    imageRows.forEach(row => {
      const image = String(row.image_url || '').trim()
      const ean = String(row.ean_code || '').trim()
      if (!image && !ean) return
      ancestorsOf(row.category_id).forEach(categoryId => {
        if (!imageByCategory.has(categoryId)) imageByCategory.set(categoryId, { image, ean })
      })
    })

    const rootNameOf = category => {
      let current = category
      const visited = new Set()
      while (current?.parent_id != null && !visited.has(Number(current.id))) {
        visited.add(Number(current.id))
        current = categoryById.get(Number(current.parent_id)) || current
      }
      return String(current?.name || category.gender || '').toUpperCase()
    }

    const pathOf = category => {
      const names = []
      const visited = new Set()
      let current = category
      while (current && !visited.has(Number(current.id))) {
        visited.add(Number(current.id))
        names.unshift(current.name)
        current = current.parent_id == null ? null : categoryById.get(Number(current.parent_id))
      }
      return names.join(' > ')
    }

    const response = categories.map(category => {
      const image = imageByCategory.get(Number(category.id)) || {}
      return {
        ...category,
        category_path: pathOf(category),
        root_name: rootNameOf(category),
        product_count: countSets.get(Number(category.id))?.size || 0,
        representative_image: image.image || '',
        representative_ean: image.ean || ''
      }
    })

    return res.json({ categories: response })
  } catch (error) {
    return res.status(500).json({
      message: 'Unable to load categories',
      error: process.env.NODE_ENV === 'production' ? undefined : String(error?.message || error)
    })
  }
})

module.exports = router
