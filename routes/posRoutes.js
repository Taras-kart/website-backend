// routes/posRoutes.js
// POS in-store sale confirmation route
const express = require('express')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()

const crypto = require('crypto')
const uuid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const s = b.toString('hex')
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`
}

/**
 * POST /api/sales/confirm
 * Confirms a POS in-store sale.
 * - Stock was already deducted from on_hand into reserved during scanning
 * - This route creates the sale record and clears the reserved amount
 * - Idempotent: safe to call twice with the same client_action_id
 *
 * Body: {
 *   sale_id,          — client-generated UUID for this sale session
 *   branch_id,        — branch where the sale happened
 *   payment: { method, ref },  — CASH / UPI / ONLINE + optional reference
 *   items: [{ variant_id, ean_code, qty, price, mrp? }],
 *   client_action_id  — idempotency key
 * }
 */
router.post('/confirm', requireAuth, async (req, res) => {
  const {
    sale_id,
    branch_id,
    payment,
    items,
    client_action_id
  } = req.body || {}

  // Validation
  if (!sale_id) return res.status(400).json({ message: 'sale_id required' })
  if (!client_action_id) return res.status(400).json({ message: 'client_action_id required' })
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: 'items required' })

  const branchId = Number(branch_id || req.user?.branch_id || 0)
  if (!branchId) return res.status(400).json({ message: 'branch_id required' })

  const paymentMethod = String(payment?.method || 'CASH').toUpperCase()
  const paymentRef = payment?.ref || null

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Idempotency check — prevent double confirm
    const idem = await client.query(
      'SELECT key FROM idempotency_keys WHERE key = $1',
      [client_action_id]
    )
    if (idem.rowCount) {
      await client.query('COMMIT')
      // Find and return the existing sale created for this action
      const existing = await pool.query(
        `SELECT id FROM sales WHERE source='POS' AND branch_id=$1
         ORDER BY created_at DESC LIMIT 1`,
        [branchId]
      )
      return res.json({ ok: true, idempotent: true, sale_id: existing.rows[0]?.id || sale_id })
    }

    // Calculate total from items
    let total = 0
    const normalizedItems = []
    for (const it of items) {
      const variantId = Number(it?.variant_id)
      const qty = Number(it?.qty || 1)
      const price = Number(it?.price || 0)
      const mrp = Number(it?.mrp ?? it?.price ?? 0)
      if (!variantId || qty <= 0) continue
      total += price * qty
      normalizedItems.push({ variantId, qty, price, mrp, ean_code: it?.ean_code || null })
    }

    if (!normalizedItems.length) {
      await client.query('ROLLBACK')
      return res.status(400).json({ message: 'No valid items found' })
    }

    // Create the sale record
    const saleInsert = await client.query(
      `INSERT INTO sales
       (source, status, payment_status, payment_method, branch_id, total, totals,
        shipping_address, created_at)
       VALUES
       ('POS', 'DELIVERED', 'PAID', $1, $2, $3, $4::jsonb, '{}'::jsonb, now())
       RETURNING id`,
      [
        paymentMethod,
        branchId,
        total,
        JSON.stringify({ payable: total, bagTotal: total, paymentRef })
      ]
    )

    const saleDbId = saleInsert.rows[0].id

    // Insert sale items
    for (const it of normalizedItems) {
      await client.query(
        `INSERT INTO sale_items
         (id, sale_id, variant_id, qty, price, mrp, ean_code)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
        [uuid(), saleDbId, it.variantId, it.qty, it.price, it.mrp, it.ean_code]
      )
    }

    // Clear reserved stock — items are now sold and out the door
    for (const it of normalizedItems) {
      await client.query(
        `UPDATE branch_variant_stock
         SET reserved = GREATEST(0, reserved - $3)
         WHERE branch_id = $1 AND variant_id = $2`,
        [branchId, it.variantId, it.qty]
      )
    }

    // Mark idempotency key so duplicate confirms are rejected
    await client.query(
      'INSERT INTO idempotency_keys (key) VALUES ($1)',
      [client_action_id]
    )

    await client.query('COMMIT')

    return res.json({
      ok: true,
      sale_id: saleDbId,
      total,
      payment_method: paymentMethod,
      items_count: normalizedItems.length
    })

  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    console.error('POS confirm error:', e.message)
    return res.status(500).json({ message: e.message || 'Server error' })
  } finally {
    client.release()
  }
})

module.exports = router
