const express = require('express')
const pool = require('../db')

const router = express.Router()

const clean = value => String(value || '').trim()
const validEan = value => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(clean(value))

router.get('/', async (req, res) => {
  try {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'

    const [categoryResult, productResult, imageResult] = await Promise.all([
      pool.query(`
        SELECT id, parent_id, gender, name, slug, level, sort_order
        FROM product_categories
        WHERE is_active = TRUE
        ORDER BY level ASC, sort_order ASC, name ASC
      `),
      pool.query(`
        SELECT id, category_id
        FROM products
        WHERE is_active = TRUE
          AND deleted_at IS NULL
          AND category_id IS NOT NULL
      `),
      pool.query(`
        SELECT DISTINCT
          p.id AS product_id,
          p.category_id,
          COALESCE(
            NULLIF(BTRIM(pci.image_url), ''),
            NULLIF(BTRIM(v.image_url), ''),
            NULLIF(BTRIM(pi.image_url), '')
          ) AS stored_image,
          NULLIF(BTRIM(b.ean_code), '') AS ean_code,
          CASE
            WHEN NULLIF(BTRIM(pci.image_url), '') IS NOT NULL THEN 0
            WHEN NULLIF(BTRIM(v.image_url), '') IS NOT NULL THEN 1
            WHEN NULLIF(BTRIM(pi.image_url), '') IS NOT NULL THEN 2
            ELSE 3
          END AS image_priority
        FROM products p
        JOIN product_variants v
          ON v.product_id = p.id
         AND v.is_active = TRUE
        LEFT JOIN product_colour_images pci
          ON pci.product_id = p.id
         AND LOWER(BTRIM(pci.colour)) = LOWER(BTRIM(v.colour))
         AND LOWER(BTRIM(COALESCE(pci.fit, ''))) = LOWER(BTRIM(COALESCE(v.fit, '')))
        LEFT JOIN barcodes b
          ON b.variant_id = v.id
        LEFT JOIN product_images pi
          ON pi.ean_code = b.ean_code
        WHERE p.is_active = TRUE
          AND p.deleted_at IS NULL
          AND p.category_id IS NOT NULL
          AND (
            NULLIF(BTRIM(pci.image_url), '') IS NOT NULL
            OR NULLIF(BTRIM(v.image_url), '') IS NOT NULL
            OR NULLIF(BTRIM(pi.image_url), '') IS NOT NULL
            OR NULLIF(BTRIM(b.ean_code), '') IS NOT NULL
          )
        ORDER BY image_priority ASC, p.id ASC
      `)
    ])

    const categories = categoryResult.rows
    const categoryById = new Map(categories.map(category => [Number(category.id), category]))
    const productIdsByCategory = new Map(categories.map(category => [Number(category.id), new Set()]))
    const candidatesByCategory = new Map(categories.map(category => [Number(category.id), []]))
    const candidateKeysByCategory = new Map(categories.map(category => [Number(category.id), new Set()]))

    const ancestorsOf = categoryId => {
      const ancestors = []
      const visited = new Set()
      let current = categoryById.get(Number(categoryId))

      while (current && !visited.has(Number(current.id))) {
        const id = Number(current.id)
        visited.add(id)
        ancestors.push(id)
        current = current.parent_id == null ? null : categoryById.get(Number(current.parent_id))
      }

      return ancestors
    }

    productResult.rows.forEach(product => {
      ancestorsOf(product.category_id).forEach(categoryId => {
        productIdsByCategory.get(categoryId)?.add(Number(product.id))
      })
    })

    const addCandidate = (categoryId, url, ean, source) => {
      const candidateUrl = clean(url)
      if (!candidateUrl) return

      const candidates = candidatesByCategory.get(categoryId)
      const keys = candidateKeysByCategory.get(categoryId)
      if (!candidates || !keys || candidates.length >= 16 || keys.has(candidateUrl)) return

      keys.add(candidateUrl)
      candidates.push({ url: candidateUrl, ean: clean(ean), source })
    }

    imageResult.rows.forEach(row => {
      const storedImage = clean(row.stored_image)
      const ean = clean(row.ean_code)

      ancestorsOf(row.category_id).forEach(categoryId => {
        if (storedImage) addCandidate(categoryId, storedImage, ean, 'database')
      })
    })

    imageResult.rows.forEach(row => {
      const ean = clean(row.ean_code)
      if (!validEan(ean)) return

      const generatedUrl = `https://res.cloudinary.com/${cloud}/image/upload/f_auto,q_auto/products/${encodeURIComponent(ean)}`
      ancestorsOf(row.category_id).forEach(categoryId => {
        addCandidate(categoryId, generatedUrl, ean, 'barcode')
      })
    })

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

    const rootNameOf = category => {
      const path = pathOf(category).split(' > ').filter(Boolean)
      return clean(path[0] || category.gender).toUpperCase()
    }

    const response = categories.map(category => {
      const candidates = candidatesByCategory.get(Number(category.id)) || []
      const first = candidates[0] || {}

      return {
        ...category,
        category_path: pathOf(category),
        root_name: rootNameOf(category),
        product_count: productIdsByCategory.get(Number(category.id))?.size || 0,
        representative_image: first.url || '',
        representative_ean: first.ean || '',
        image_candidates: candidates
      }
    })

    return res.status(200).json({ categories: response })
  } catch (error) {
    return res.status(500).json({
      message: 'Unable to load categories',
      error: String(error?.message || error),
      code: error?.code || null
    })
  }
})

module.exports = router
