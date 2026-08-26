const express = require('express')
const jwt = require('jsonwebtoken')
const pool = require('../db')

const router = express.Router()

const clean = value => String(value || '').replace(/\s+/g, ' ').trim()
const positiveInteger = value => {
  const number = Number.parseInt(String(value || ''), 10)
  return Number.isInteger(number) && number > 0 ? number : null
}
const normalizeGender = value => {
  const gender = clean(value).toUpperCase()
  return ['MEN', 'WOMEN', 'KIDS'].includes(gender) ? gender : ''
}
const slugify = value => clean(value)
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return res.status(401).json({ message: 'Unauthorized' })

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret')
    return next()
  } catch {
    return res.status(401).json({ message: 'Unauthorized' })
  }
}

async function uniqueSlug(db, gender, name, excludedId = null) {
  const base = slugify(`${gender}-${name}`) || `category-${Date.now()}`
  let candidate = base
  let suffix = 2

  while (true) {
    const result = await db.query(
      `SELECT 1
       FROM product_categories
       WHERE slug = $1
         AND ($2::bigint IS NULL OR id <> $2::bigint)
       LIMIT 1`,
      [candidate, excludedId]
    )
    if (!result.rows.length) return candidate
    candidate = `${base}-${suffix}`
    suffix += 1
  }
}

async function ensureRootCategories(db) {
  const roots = [
    ['WOMEN', 'Women', 'women', 1],
    ['MEN', 'Men', 'men', 2],
    ['KIDS', 'Kids', 'kids', 3]
  ]

  for (const [gender, name, slug, sortOrder] of roots) {
    await db.query(
      `INSERT INTO product_categories (parent_id, gender, name, slug, level, sort_order, is_active, created_at, updated_at)
       SELECT NULL, $1, $2, $3, 0, $4, TRUE, NOW(), NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM product_categories WHERE parent_id IS NULL AND UPPER(BTRIM(gender)) = $1
       )`,
      [gender, name, slug, sortOrder]
    )
  }
}

function buildCategoryMetadata(categories) {
  const categoryById = new Map(categories.map(category => [Number(category.id), category]))

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

  return { categoryById, pathOf }
}

async function loadCategoryRows(db, includeInactive) {
  const result = await db.query(`
    SELECT
      c.id,
      c.parent_id,
      c.gender,
      c.name,
      c.slug,
      c.level,
      c.sort_order,
      c.is_active,
      c.created_at,
      c.updated_at,
      COUNT(p.id)::int AS direct_product_count
    FROM product_categories c
    LEFT JOIN products p
      ON p.category_id = c.id
     AND p.is_active = TRUE
     AND p.deleted_at IS NULL
    ${includeInactive ? '' : 'WHERE c.is_active = TRUE'}
    GROUP BY c.id
    ORDER BY c.level ASC, c.sort_order ASC, c.name ASC
  `)
  return result.rows
}

function enrichCategoryRows(rows) {
  const { categoryById, pathOf } = buildCategoryMetadata(rows)
  const children = new Map()

  rows.forEach(category => {
    if (category.parent_id == null) return
    const parentId = Number(category.parent_id)
    children.set(parentId, [...(children.get(parentId) || []), Number(category.id)])
  })

  const descendantsOf = categoryId => {
    const output = []
    const queue = [...(children.get(Number(categoryId)) || [])]
    const visited = new Set()

    while (queue.length) {
      const id = queue.shift()
      if (visited.has(id)) continue
      visited.add(id)
      output.push(id)
      queue.push(...(children.get(id) || []))
    }

    return output
  }

  return rows.map(category => {
    const descendants = descendantsOf(category.id)
    const productCount = [Number(category.id), ...descendants].reduce((total, id) => {
      return total + Number(categoryById.get(id)?.direct_product_count || 0)
    }, 0)

    return {
      ...category,
      category_path: pathOf(category),
      root_name: clean(pathOf(category).split(' > ')[0] || category.gender).toUpperCase(),
      product_count: productCount,
      descendant_count: descendants.length
    }
  })
}

router.get('/admin', requireAdminAuth, async (req, res) => {
  try {
    await ensureRootCategories(pool)
    const rows = enrichCategoryRows(await loadCategoryRows(pool, true))
    return res.status(200).json({ rows })
  } catch (error) {
    return res.status(500).json({ message: 'Unable to load categories', error: String(error?.message || error), code: error?.code || null })
  }
})

router.get('/:id/impact', requireAdminAuth, async (req, res) => {
  const categoryId = positiveInteger(req.params.id)
  if (!categoryId) return res.status(400).json({ message: 'Invalid category' })

  try {
    const result = await pool.query(`
      WITH RECURSIVE subtree AS (
        SELECT id, is_active
        FROM product_categories
        WHERE id = $1
        UNION ALL
        SELECT child.id, child.is_active
        FROM product_categories child
        JOIN subtree parent ON child.parent_id = parent.id
      )
      SELECT
        GREATEST(COUNT(*)::int - 1, 0) AS descendant_count,
        GREATEST(COUNT(*) FILTER (WHERE is_active)::int - 1, 0) AS active_descendant_count,
        (
          SELECT COUNT(*)::int
          FROM products p
          WHERE p.category_id IN (SELECT id FROM subtree)
            AND p.is_active = TRUE
            AND p.deleted_at IS NULL
        ) AS subtree_product_count
      FROM subtree
    `, [categoryId])

    if (!result.rows.length) return res.status(404).json({ message: 'Category not found' })
    return res.status(200).json(result.rows[0])
  } catch (error) {
    return res.status(500).json({ message: 'Unable to check category', error: String(error?.message || error), code: error?.code || null })
  }
})

router.post('/', requireAdminAuth, async (req, res) => {
  const name = clean(req.body?.name)
  const parentId = positiveInteger(req.body?.parent_id)
  const requestedSortOrder = req.body?.sort_order

  if (!name) return res.status(400).json({ message: 'Category name is required' })
  if (!parentId) return res.status(400).json({ message: 'Parent category is required' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const parentResult = await client.query(
      `SELECT id, gender, level, is_active FROM product_categories WHERE id = $1 FOR UPDATE`,
      [parentId]
    )
    if (!parentResult.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Parent category not found' })
    }

    const parent = parentResult.rows[0]
    if (!parent.is_active) {
      await client.query('ROLLBACK')
      return res.status(400).json({ message: 'Cannot add under an inactive category' })
    }

    const duplicate = await client.query(
      `SELECT id FROM product_categories WHERE parent_id = $1 AND LOWER(BTRIM(name)) = LOWER(BTRIM($2)) LIMIT 1`,
      [parentId, name]
    )
    if (duplicate.rows.length) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: 'This category already exists under the selected parent' })
    }

    let sortOrder = Number.parseInt(String(requestedSortOrder ?? ''), 10)
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      const orderResult = await client.query(
        `SELECT COALESCE(MAX(sort_order), -1)::int + 1 AS next_order FROM product_categories WHERE parent_id = $1`,
        [parentId]
      )
      sortOrder = Number(orderResult.rows[0].next_order)
    }

    const gender = normalizeGender(parent.gender)
    const slug = await uniqueSlug(client, gender, name)
    const inserted = await client.query(
      `INSERT INTO product_categories (parent_id, gender, name, slug, level, sort_order, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
       RETURNING *`,
      [parentId, gender, name, slug, Number(parent.level) + 1, sortOrder]
    )
    await client.query('COMMIT')
    return res.status(201).json(inserted.rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    return res.status(500).json({ message: 'Unable to add category', error: String(error?.message || error), code: error?.code || null })
  } finally {
    client.release()
  }
})

router.put('/:id', requireAdminAuth, async (req, res) => {
  const categoryId = positiveInteger(req.params.id)
  const name = clean(req.body?.name)
  const sortOrder = Number.parseInt(String(req.body?.sort_order ?? ''), 10)

  if (!categoryId) return res.status(400).json({ message: 'Invalid category' })
  if (!name) return res.status(400).json({ message: 'Category name is required' })
  if (!Number.isInteger(sortOrder) || sortOrder < 0) return res.status(400).json({ message: 'Invalid sort order' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const currentResult = await client.query(
      `SELECT id, parent_id, gender FROM product_categories WHERE id = $1 FOR UPDATE`,
      [categoryId]
    )
    if (!currentResult.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Category not found' })
    }

    const current = currentResult.rows[0]
    if (current.parent_id == null) {
      await client.query('ROLLBACK')
      return res.status(400).json({ message: 'Root gender categories cannot be edited here' })
    }

    const duplicate = await client.query(
      `SELECT id
       FROM product_categories
       WHERE parent_id = $1 AND LOWER(BTRIM(name)) = LOWER(BTRIM($2)) AND id <> $3
       LIMIT 1`,
      [current.parent_id, name, categoryId]
    )
    if (duplicate.rows.length) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: 'This category already exists under the selected parent' })
    }

    const slug = await uniqueSlug(client, normalizeGender(current.gender), name, categoryId)
    const updated = await client.query(
      `UPDATE product_categories
       SET name = $1, slug = $2, sort_order = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [name, slug, sortOrder, categoryId]
    )
    await client.query('COMMIT')
    return res.status(200).json(updated.rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    return res.status(500).json({ message: 'Unable to update category', error: String(error?.message || error), code: error?.code || null })
  } finally {
    client.release()
  }
})

router.patch('/:id/status', requireAdminAuth, async (req, res) => {
  const categoryId = positiveInteger(req.params.id)
  const isActive = req.body?.is_active === true
  const cascade = req.body?.cascade === true
  if (!categoryId) return res.status(400).json({ message: 'Invalid category' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const currentResult = await client.query(
      `SELECT id, parent_id FROM product_categories WHERE id = $1 FOR UPDATE`,
      [categoryId]
    )
    if (!currentResult.rows.length) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Category not found' })
    }
    if (currentResult.rows[0].parent_id == null) {
      await client.query('ROLLBACK')
      return res.status(400).json({ message: 'Root gender categories cannot be deleted' })
    }

    const descendantsResult = await client.query(`
      WITH RECURSIVE descendants AS (
        SELECT id FROM product_categories WHERE parent_id = $1
        UNION ALL
        SELECT child.id
        FROM product_categories child
        JOIN descendants parent ON child.parent_id = parent.id
      )
      SELECT id FROM descendants
    `, [categoryId])
    const descendantIds = descendantsResult.rows.map(row => Number(row.id))

    if (!isActive && descendantIds.length && !cascade) {
      await client.query('ROLLBACK')
      return res.status(409).json({ message: 'Enable child category deletion to continue' })
    }

    const ids = cascade ? [categoryId, ...descendantIds] : [categoryId]
    await client.query(
      `UPDATE product_categories SET is_active = $1, updated_at = NOW() WHERE id = ANY($2::bigint[])`,
      [isActive, ids]
    )
    await client.query('COMMIT')
    return res.status(200).json({ updated_ids: ids, is_active: isActive })
  } catch (error) {
    await client.query('ROLLBACK')
    return res.status(500).json({ message: 'Unable to update category status', error: String(error?.message || error), code: error?.code || null })
  } finally {
    client.release()
  }
})

router.get('/', async (req, res) => {
  try {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'
    const includeInactive = String(req.query.active || 'true').toLowerCase() === 'false'
    const categoryRows = await loadCategoryRows(pool, includeInactive)
    const categories = enrichCategoryRows(categoryRows)
    const categoryById = new Map(categories.map(category => [Number(category.id), category]))
    const candidatesByCategory = new Map(categories.map(category => [Number(category.id), []]))
    const candidateKeysByCategory = new Map(categories.map(category => [Number(category.id), new Set()]))

    const imageResult = await pool.query(`
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
      JOIN product_variants v ON v.product_id = p.id AND v.is_active = TRUE
      LEFT JOIN product_colour_images pci
        ON pci.product_id = p.id
       AND LOWER(BTRIM(pci.colour)) = LOWER(BTRIM(v.colour))
       AND LOWER(BTRIM(COALESCE(pci.fit, ''))) = LOWER(BTRIM(COALESCE(v.fit, '')))
      LEFT JOIN barcodes b ON b.variant_id = v.id
      LEFT JOIN product_images pi ON pi.ean_code = b.ean_code
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

    const ancestorsOf = categoryId => {
      const output = []
      const visited = new Set()
      let current = categoryById.get(Number(categoryId))
      while (current && !visited.has(Number(current.id))) {
        const id = Number(current.id)
        visited.add(id)
        output.push(id)
        current = current.parent_id == null ? null : categoryById.get(Number(current.parent_id))
      }
      return output
    }

    const addCandidate = (categoryId, url, ean, source) => {
      const candidateUrl = clean(url)
      const candidates = candidatesByCategory.get(categoryId)
      const keys = candidateKeysByCategory.get(categoryId)
      if (!candidateUrl || !candidates || !keys || candidates.length >= 16 || keys.has(candidateUrl)) return
      keys.add(candidateUrl)
      candidates.push({ url: candidateUrl, ean: clean(ean), source })
    }

    imageResult.rows.forEach(row => {
      const storedImage = clean(row.stored_image)
      const ean = clean(row.ean_code).replace(/^-+/, '')
      ancestorsOf(row.category_id).forEach(categoryId => {
        if (storedImage) addCandidate(categoryId, storedImage, ean, 'database')
      })
    })

    imageResult.rows.forEach(row => {
      const ean = clean(row.ean_code).replace(/^-+/, '')
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ean)) return
      const generatedUrl = `https://res.cloudinary.com/${cloud}/image/upload/f_auto,q_auto/products/${encodeURIComponent(ean)}`
      ancestorsOf(row.category_id).forEach(categoryId => addCandidate(categoryId, generatedUrl, ean, 'barcode'))
    })

    const response = categories.map(category => {
      const candidates = candidatesByCategory.get(Number(category.id)) || []
      return {
        ...category,
        representative_image: candidates[0]?.url || '',
        representative_ean: candidates[0]?.ean || '',
        image_candidates: candidates
      }
    })

    return res.status(200).json({ categories: response })
  } catch (error) {
    return res.status(500).json({ message: 'Unable to load categories', error: String(error?.message || error), code: error?.code || null })
  }
})

module.exports = router
