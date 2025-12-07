const router = require('express').Router()
const pool = require('../db')
const { getMyOrders, getTracking } = require('../controllers/orderController')
const Shiprocket = require('../services/shiprocketService')

router.get('/', getMyOrders)
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
      return res
        .status(400)
        .json({ ok: false, message: 'Delivered or RTO orders cannot be cancelled' })
    }

    const shipQ = await client.query(
      `SELECT DISTINCT shiprocket_order_id
       FROM shipments
       WHERE sale_id = $1
         AND shiprocket_order_id IS NOT NULL`,
      [sale_id]
    )

    shiprocketOrderIds = shipQ.rows.map(r => r.shiprocket_order_id).filter(Boolean)

    await client.query(
      `UPDATE sales
       SET status = $2
       WHERE id = $1::uuid`,
      [sale_id, 'CANCELLED']
    )

    await client.query(
      `UPDATE shipments
       SET status = $2
       WHERE sale_id = $1`,
      [sale_id, 'CANCELLED']
    )

    await client.query(
      `INSERT INTO order_cancellations (sale_id, payment_type, reason, cancellation_source, created_at)
       VALUES ($1::uuid, $2, $3, $4, now())
       ON CONFLICT DO NOTHING`,
      [sale_id, payment_type || salePaymentStatus, reason || null, cancellation_source || null]
    )

    await client.query('COMMIT')
    client.release()
  } catch (e) {
    try { await client.query('ROLLBACK') } catch (_) {}
    client.release()
    console.error('Order cancel error:', e)
    return res.status(500).json({
      ok: false,
      message: 'Failed to cancel order',
      error: e.message
    })
  }

  if (shiprocketOrderIds.length) {
    try {
      const sr = new Shiprocket({ pool })
      await sr.init()
      await sr.cancelOrders({ order_ids: shiprocketOrderIds })
    } catch (e) {
      console.error('Shiprocket cancel error', e.response?.data || e.message || e)
    }
  }

  return res.json({
    ok: true,
    id: sale_id,
    status: 'CANCELLED',
    payment_type: payment_type || salePaymentStatus || null,
    reason: reason || null,
    cancellation_source: cancellation_source || null
  })
})

module.exports = router
