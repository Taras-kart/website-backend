const express = require('express')
const pool = require('../db')

const router = express.Router()

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH RECURSIVE tree AS (
        SELECT id, parent_id, gender, name, slug, level, sort_order, is_active, name::text AS category_path, UPPER(name)::text AS root_name
        FROM product_categories
        WHERE parent_id IS NULL
        UNION ALL
        SELECT pc.id, pc.parent_id, COALESCE(pc.gender, tree.gender), pc.name, pc.slug, pc.level, pc.sort_order, pc.is_active, tree.category_path || ' > ' || pc.name, tree.root_name
        FROM product_categories pc
        JOIN tree ON tree.id = pc.parent_id
      ), descendants AS (
        SELECT id AS ancestor_id, id AS category_id
        FROM product_categories
        UNION ALL
        SELECT descendants.ancestor_id, pc.id
        FROM descendants
        JOIN product_categories pc ON pc.parent_id = descendants.category_id
      ), counts AS (
        SELECT descendants.ancestor_id AS category_id, COUNT(DISTINCT products.id)::int AS product_count
        FROM descendants
        JOIN products ON products.category_id = descendants.category_id
          AND products.is_active = TRUE
          AND products.deleted_at IS NULL
        GROUP BY descendants.ancestor_id
      ), image_candidates AS (
        SELECT
          descendants.ancestor_id AS category_id,
          barcodes.ean_code,
          COALESCE(
            NULLIF(to_jsonb(product_images) ->> 'image_url', ''),
            NULLIF(to_jsonb(product_images) ->> 'imageUrl', ''),
            NULLIF(to_jsonb(product_images) ->> 'url', ''),
            NULLIF(to_jsonb(product_images) ->> 'secure_url', '')
          ) AS image_url,
          LOWER(COALESCE(to_jsonb(product_images) ->> 'image_type', '')) AS image_type,
          ROW_NUMBER() OVER (
            PARTITION BY descendants.ancestor_id
            ORDER BY
              CASE WHEN LOWER(COALESCE(to_jsonb(product_images) ->> 'image_type', '')) = 'front' THEN 0 ELSE 1 END,
              CASE WHEN COALESCE(
                NULLIF(to_jsonb(product_images) ->> 'image_url', ''),
                NULLIF(to_jsonb(product_images) ->> 'imageUrl', ''),
                NULLIF(to_jsonb(product_images) ->> 'url', ''),
                NULLIF(to_jsonb(product_images) ->> 'secure_url', '')
              ) IS NOT NULL THEN 0 ELSE 1 END,
              products.updated_at DESC,
              products.id DESC
          ) AS image_rank
        FROM descendants
        JOIN products ON products.category_id = descendants.category_id
          AND products.is_active = TRUE
          AND products.deleted_at IS NULL
        JOIN product_variants ON product_variants.product_id = products.id
          AND product_variants.is_active = TRUE
        JOIN barcodes ON barcodes.variant_id = product_variants.id
        LEFT JOIN product_images ON product_images.ean_code = barcodes.ean_code
        WHERE barcodes.ean_code IS NOT NULL
          AND TRIM(barcodes.ean_code) <> ''
      )
      SELECT
        tree.id,
        tree.parent_id,
        tree.gender,
        tree.name,
        tree.slug,
        tree.level,
        tree.sort_order,
        tree.category_path,
        tree.root_name,
        COALESCE(counts.product_count, 0) AS product_count,
        image_candidates.image_url AS representative_image,
        image_candidates.ean_code AS representative_ean
      FROM tree
      LEFT JOIN counts ON counts.category_id = tree.id
      LEFT JOIN image_candidates ON image_candidates.category_id = tree.id
        AND image_candidates.image_rank = 1
      WHERE tree.is_active = TRUE
      ORDER BY tree.root_name, tree.level, tree.sort_order, tree.name
    `)
    return res.json({ categories: result.rows })
  } catch (error) {
    return res.status(500).json({ message: 'Unable to load categories' })
  }
})

module.exports = router
