const router = require('express').Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { getTracking } = require('../controllers/orderController')
const Shiprocket = require('../services/shiprocketService')

router.get('/', requireAuth, async (req, res) => {
  try {
    const role = String(req.user?.role_enum || req.user?.role || '').toUpperCase()
    const isSuper = role === 'SUPER_ADMIN'
    const userBranchId = Number(req.user?.branch_id || 0)

    const requestedBranchIdRaw = String(req.query.branch_id || '').trim()
    const requestedBranchId = requestedBranchIdRaw ? Number(requestedBranchIdRaw) : null

    const params = []
    const where = []

    if (isSuper) {
      if (requestedBranchId && Number.isFinite(requestedBranchId)) {
        params.push(requestedBranchId)
        where.push(`s.branch_id = $${params.length}`)
      }
    } else {
      if (!userBranchId) return res.status(403).json({ message: 'Forbidden' })
      params.push(userBranchId)
      where.push(`s.branch_id = $${params.length}`)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const q = await pool.query(
      `SELECT
         s.id,
         s.status,
         s.payment_status,
         s.created_at,
         s.total,
         s.totals,
         s.branch_id,
         s.customer_name,
         s.customer_email,
         s.customer_mobile
       FROM sales s
       ${whereSql}
       ORDER BY s.created_at DESC NULLS LAST, s.id DESC
       LIMIT 500`,
      params
    )

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')

    return res.json(q.rows || [])
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.get('/track/:orderId/:channelId?', getTracking)

router.post('/cancel', async (req, res) => {
  const { sale_id, payment_type, reason, cancellation_source } = req.body || {}

  if (!sale_id) {
    return res.status(400).json({ ok: false, message: 'sale_id required' })
  }

  const client = await pool.connect()
  let shiprocketOrderIds = []
  let salePaymentStatus = null

  try {
    await client.query('BEGIN')

    const orderQ = await client.query(
      `SELECT id, status, payment_status
       FROM sales
       WHERE id = $1::uuid
       FOR UPDATE`,
      [sale_id]
    )

    if (!orderQ.rowCount) {
      await client.query('ROLLBACK')
      client.release()
      return res.status(404).json({ ok: false, message: 'Order not found' })
    }

    const sale = orderQ.rows[0]
    salePaymentStatus = sale.payment_status || null
    const currentStatus = String(sale.status || '').toUpperCase()

    if (currentStatus === 'CANCELLED') {
      await client.query('ROLLBACK')
      client.release()
      return res.status(400).json({ ok: false, message: 'Order already cancelled' })
    }

    if (currentStatus === 'DELIVERED' || currentStatus === 'RTO') {
      await client.query('ROLLBACK')
      client.release()
      return res.status(400).json({ ok: false, message: 'Order cannot be cancelled' })
    }

    const shipQ = await client.query(
      `SELECT DISTINCT shiprocket_order_id
       FROM shipments
       WHERE sale_id = $1
         AND shiprocket_order_id IS NOT NULL`,
      [sale_id]
    )

    shiprocketOrderIds = shipQ.rows.map(r => r.shiprocket_order_id).filter(Boolean)

    await client.query(`UPDATE sales SET status = 'CANCELLED' WHERE id = $1::uuid`, [sale_id])
    await client.query(`UPDATE shipments SET status = 'CANCELLED' WHERE sale_id = $1`, [sale_id])

    await client.query(
      `INSERT INTO order_cancellations (sale_id, payment_type, reason, cancellation_source, created_at)
       VALUES ($1::uuid,$2,$3,$4,now())
       ON CONFLICT DO NOTHING`,
      [sale_id, payment_type || salePaymentStatus, reason || null, cancellation_source || null]
    )

    await client.query('COMMIT')
    client.release()
  } catch {
    try { await client.query('ROLLBACK') } catch {}
    try { client.release() } catch {}
    return res.status(500).json({ ok: false, message: 'Failed to cancel order' })
  }

  if (shiprocketOrderIds.length) {
    try {
      const sr = new Shiprocket({ pool })
      await sr.init()
      await sr.cancelOrders({ order_ids: shiprocketOrderIds })
    } catch {}
  }

  return res.json({ ok: true, id: sale_id, status: 'CANCELLED' })
})

module.exports = router
