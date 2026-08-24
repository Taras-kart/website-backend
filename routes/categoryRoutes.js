const express = require('express')
const pool = require('../db')

const router = express.Router()

router.get('/', async (req, res) => {
  try {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'

    const categoryResult = await pool.query(`
      SELECT
        id,
        parent_id,
        gender,
        name,
        slug,
        level,
        sort_order
      FROM public.product_categories
      WHERE is_active = TRUE
      ORDER BY
        level ASC,
        sort_order ASC,
        name ASC
    `)

    const productResult = await pool.query(
      `
        SELECT DISTINCT ON (p.id)
          p.id AS product_id,
          p.category_id,
          COALESCE(
            NULLIF(pci.image_url, ''),
            NULLIF(v.image_url, ''),
            NULLIF(pi.image_url, ''),
            CASE
              WHEN COALESCE(
                bc_self.ean_code,
                bc_any.ean_code,
                ''
              ) <> ''
                THEN CONCAT(
                  'https://res.cloudinary.com/',
                  $1::text,
                  '/image/upload/f_auto,q_auto/products/',
                  COALESCE(
                    bc_self.ean_code,
                    bc_any.ean_code
                  )
                )
              ELSE NULL
            END
          ) AS image_url,
          COALESCE(
            bc_self.ean_code,
            bc_any.ean_code,
            ''
          ) AS ean_code
        FROM public.products p
        JOIN public.product_variants v
          ON v.product_id = p.id
         AND v.is_active = TRUE
        LEFT JOIN public.product_colour_images pci
          ON pci.product_id = p.id
         AND LOWER(BTRIM(pci.colour)) =
             LOWER(BTRIM(v.colour))
         AND LOWER(BTRIM(COALESCE(pci.fit, ''))) =
             LOWER(BTRIM(COALESCE(v.fit, '')))
        LEFT JOIN LATERAL (
          SELECT b.ean_code
          FROM public.barcodes b
          WHERE b.variant_id = v.id
          ORDER BY b.id ASC
          LIMIT 1
        ) bc_self ON TRUE
        LEFT JOIN LATERAL (
          SELECT b2.ean_code
          FROM public.product_variants v2
          JOIN public.products p2
            ON p2.id = v2.product_id
          JOIN public.barcodes b2
            ON b2.variant_id = v2.id
          WHERE p2.name = p.name
            AND p2.brand_name = p.brand_name
            AND v2.size = v.size
            AND v2.colour = v.colour
            AND COALESCE(v2.fit, '') =
                COALESCE(v.fit, '')
          ORDER BY b2.id ASC
          LIMIT 1
        ) bc_any ON TRUE
        LEFT JOIN LATERAL (
          SELECT images.image_url
          FROM public.product_images images
          WHERE images.ean_code = COALESCE(
            bc_self.ean_code,
            bc_any.ean_code
          )
          ORDER BY images.uploaded_at DESC
          LIMIT 1
        ) pi ON TRUE
        WHERE p.is_active = TRUE
          AND p.deleted_at IS NULL
          AND p.category_id IS NOT NULL
        ORDER BY
          p.id,
          CASE
            WHEN NULLIF(pci.image_url, '') IS NOT NULL
              THEN 0
            ELSE 1
          END,
          CASE
            WHEN NULLIF(v.image_url, '') IS NOT NULL
              THEN 0
            ELSE 1
          END,
          CASE
            WHEN NULLIF(pi.image_url, '') IS NOT NULL
              THEN 0
            ELSE 1
          END,
          v.id DESC
      `,
      [cloud]
    )

    const categories = categoryResult.rows
    const products = productResult.rows

    const categoryById = new Map(
      categories.map(category => [
        Number(category.id),
        category
      ])
    )

    const productIdsByCategory = new Map(
      categories.map(category => [
        Number(category.id),
        new Set()
      ])
    )

    const imageByCategory = new Map()

    const ancestorsOf = categoryId => {
      const ancestors = []
      const visited = new Set()

      let category = categoryById.get(
        Number(categoryId)
      )

      while (
        category &&
        !visited.has(Number(category.id))
      ) {
        const id = Number(category.id)

        visited.add(id)
        ancestors.push(id)

        category =
          category.parent_id == null
            ? null
            : categoryById.get(
                Number(category.parent_id)
              )
      }

      return ancestors
    }

    products.forEach(product => {
      const productId = Number(product.product_id)
      const imageUrl = String(
        product.image_url || ''
      ).trim()

      const eanCode = String(
        product.ean_code || ''
      ).trim()

      const ancestors = ancestorsOf(
        product.category_id
      )

      ancestors.forEach(categoryId => {
        const productSet =
          productIdsByCategory.get(categoryId)

        if (productSet) {
          productSet.add(productId)
        }

        if (
          !imageByCategory.has(categoryId) &&
          (imageUrl || eanCode)
        ) {
          imageByCategory.set(categoryId, {
            imageUrl,
            eanCode
          })
        }
      })
    })

    const categoryPath = category => {
      const names = []
      const visited = new Set()

      let current = category

      while (
        current &&
        !visited.has(Number(current.id))
      ) {
        visited.add(Number(current.id))
        names.unshift(current.name)

        current =
          current.parent_id == null
            ? null
            : categoryById.get(
                Number(current.parent_id)
              )
      }

      return names.join(' > ')
    }

    const rootName = category => {
      const path = categoryPath(category)
        .split(' > ')
        .filter(Boolean)

      return String(
        path[0] || category.gender || ''
      ).toUpperCase()
    }

    const response = categories.map(category => {
      const categoryId = Number(category.id)

      const image =
        imageByCategory.get(categoryId) || {}

      const productCount =
        productIdsByCategory.get(categoryId)?.size || 0

      return {
        ...category,
        category_path: categoryPath(category),
        root_name: rootName(category),
        product_count: productCount,
        representative_image:
          image.imageUrl || '',
        representative_ean:
          image.eanCode || ''
      }
    })

    return res.status(200).json({
      categories: response
    })
  } catch (error) {
    return res.status(500).json({
      message: 'Unable to load categories',
      error: String(error?.message || error),
      code: error?.code || null
    })
  }
})

module.exports = router