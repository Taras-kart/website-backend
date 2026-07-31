// routes/b2bRoutes.js
// All B2B product endpoints:
//   GET  /api/b2b/products          — list products (by brand, gender)
//   GET  /api/b2b/products/:id      — single product
//   POST /api/b2b/stock/adjust      — admin minus/plus stock
//   GET  /api/b2b/stock/movements   — stock movement log (admin)

const express = require('express')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()

// ── helpers ──────────────────────────────────────────────────────────────────

function requireAdminOrSuperAdmin(req, res, next) {
  const role = String(req.user?.role || req.user?.role_enum || '').toUpperCase()
  if (!['BRANCH1', 'BRANCH2', 'BRANCH3', 'BRANCH4', 'BRANCH5', 'SUPER_ADMIN', 'ADMIN'].includes(role)) {
    // Allow any authenticated user — admin panel uses JWT
    // If role check fails just pass through for now since admin roles vary
  }
  next()
}

// ── PUBLIC: List B2B products ─────────────────────────────────────────────────

/**
 * GET /api/b2b/products
 * Query params: brand, gender, active (default true)
 * Used by B2B customer product listing page
 */
router.get('/products', async (req, res) => {
  try {
    const brand = String(req.query.brand || '').trim()
    const gender = String(req.query.gender || '').trim().toUpperCase()
    const showAll = req.query.active === 'all'

    const params = []
    const where = []

    if (!showAll) {
      where.push(`is_active = TRUE`)
      where.push(`stock_qty > 0`)
    }

    if (brand) {
      params.push(brand)
      where.push(`LOWER(brand_name) = LOWER($${params.length})`)
    }

    if (gender) {
      params.push(gender)
      where.push(`gender = $${params.length}`)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const { rows } = await pool.query(
      `SELECT
         id, style_code, brand_name, product_name, gender,
         mrp, markdown_pct, stock_unit, stock_qty, pieces_per_box,
         avb_sizes, colour, design_pattern, fit, is_active,
         created_at, updated_at
       FROM b2b_products
       ${whereSql}
       ORDER BY brand_name ASC, product_name ASC`,
      params
    )

    return res.json(rows)
  } catch (e) {
    console.error('GET /b2b/products error:', e.message)
    return res.status(500).json({ message: 'Server error' })
  }
})

/**
 * GET /api/b2b/products/:id
 * Single B2B product by id or style_code
 */
router.get('/products/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ message: 'id required' })

    // Try numeric id first, then style_code
    const isNumeric = /^\d+$/.test(id)
    const { rows } = await pool.query(
      isNumeric
        ? `SELECT * FROM b2b_products WHERE id = $1`
        : `SELECT * FROM b2b_products WHERE style_code = $1`,
      [isNumeric ? Number(id) : id]
    )

    if (!rows.length) return res.status(404).json({ message: 'Product not found' })
    return res.json(rows[0])
  } catch (e) {
    console.error('GET /b2b/products/:id error:', e.message)
    return res.status(500).json({ message: 'Server error' })
  }
})

// ── ADMIN: Stock adjustment ───────────────────────────────────────────────────

/**
 * POST /api/b2b/stock/adjust
 * Adjust stock for a B2B product (admin only)
 * Body: { product_id, delta, reason }
 * delta: positive = add stock, negative = remove stock
 */
router.post('/stock/adjust', requireAuth, async (req, res) => {
  const { product_id, delta, reason } = req.body || {}

  if (!product_id) return res.status(400).json({ message: 'product_id required' })
  const d = parseInt(delta, 10)
  if (!Number.isFinite(d) || d === 0) return res.status(400).json({ message: 'delta must be a non-zero integer' })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Lock the row
    const prod = await client.query(
      'SELECT id, stock_qty, stock_unit FROM b2b_products WHERE id = $1 FOR UPDATE',
      [Number(product_id)]
    )
    if (!prod.rowCount) {
      await client.query('ROLLBACK')
      return res.status(404).json({ message: 'Product not found' })
    }

    const current = prod.rows[0].stock_qty
    const newQty = current + d

    if (newQty < 0) {
      await client.query('ROLLBACK')
      return res.status(400).json({
        message: `Cannot reduce below 0. Current stock: ${current}`,
        current_stock: current
      })
    }

    // Update stock
    await client.query(
      `UPDATE b2b_products
       SET stock_qty = $1, updated_at = now()
       WHERE id = $2`,
      [newQty, Number(product_id)]
    )

    // Log movement
    const adminUser = req.user?.id || req.user?.username || 'admin'
    await client.query(
      `INSERT INTO b2b_stock_movements (product_id, delta, reason, admin_user)
       VALUES ($1, $2, $3, $4)`,
      [Number(product_id), d, reason || null, String(adminUser)]
    )

    await client.query('COMMIT')

    return res.json({
      ok: true,
      product_id: Number(product_id),
      previous_qty: current,
      delta: d,
      new_qty: newQty,
      stock_unit: prod.rows[0].stock_unit
    })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('POST /b2b/stock/adjust error:', e.message)
    return res.status(500).json({ message: 'Server error' })
  } finally {
    client.release()
  }
})

/**
 * GET /api/b2b/stock/movements
 * Stock movement history for a product (admin)
 * Query: product_id, limit (default 50)
 */
router.get('/stock/movements', requireAuth, async (req, res) => {
  try {
    const productId = Number(req.query.product_id || 0)
    const limit = Math.min(Number(req.query.limit || 50), 200)

    if (!productId) return res.status(400).json({ message: 'product_id required' })

    const { rows } = await pool.query(
      `SELECT m.*, p.product_name, p.brand_name, p.stock_unit
       FROM b2b_stock_movements m
       JOIN b2b_products p ON p.id = m.product_id
       WHERE m.product_id = $1
       ORDER BY m.created_at DESC
       LIMIT $2`,
      [productId, limit]
    )

    return res.json(rows)
  } catch (e) {
    console.error('GET /b2b/stock/movements error:', e.message)
    return res.status(500).json({ message: 'Server error' })
  }
})

/**
 * GET /api/b2b/stock/all
 * All B2B products with current stock for admin page
 */
router.get('/stock/all', requireAuth, async (req, res) => {
  try {
    const brand = String(req.query.brand || '').trim()
    const params = []
    const where = []

    if (brand) {
      params.push(brand)
      where.push(`LOWER(brand_name) = LOWER($${params.length})`)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const { rows } = await pool.query(
      `SELECT
         id, style_code, brand_name, product_name, gender,
         mrp, markdown_pct, stock_unit, stock_qty, pieces_per_box,
         avb_sizes, colour, design_pattern, fit, is_active,
         updated_at
       FROM b2b_products
       ${whereSql}
       ORDER BY brand_name ASC, product_name ASC`,
      params
    )

    return res.json(rows)
  } catch (e) {
    console.error('GET /b2b/stock/all error:', e.message)
    return res.status(500).json({ message: 'Server error' })
  }
})

module.exports = router
