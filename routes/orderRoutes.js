const router = require('express').Router()
const pool = require('../db')
const { getMyOrders, getTracking } = require('../controllers/orderController')
const Shiprocket = require('../services/shiprocketService')

router.get('/', getMyOrders)
router.get('/track/:orderId/:channelId?', getTracking)

router.post('/cancel', async (req, res) => {
  const { sale_id, payment_type, reason } = req.body || {}

  if (!sale_id) {
    return res.status(400).json({ ok: false, message: 'sale_id required' })
  }

  const client = await pool.connect()
  let shiprocketOrderIds = []
  let salePaymentStatus = null

  try {
    console.log('[CANCEL] begin tx for sale_id', sale_id)
    await client.query('BEGIN')

    console.log('[CANCEL] select sale')
    const orderQ = await client.query(
      `SELECT id, status, payment_status
       FROM sales
       WHERE id = $1::uuid
       FOR UPDATE`,
      [sale_id]
    )

    if (!orderQ.rowCount) {
      console.log('[CANCEL] sale not found')
      await client.query('ROLLBACK')
      client.release()
      return res.status(404).json({ ok: false, message: 'Order not found' })
    }

    const sale = orderQ.rows[0]
    salePaymentStatus = sale.payment_status || null
    const currentStatus = String(sale.status || '').toUpperCase()
    console.log('[CANCEL] currentStatus', currentStatus)

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

    console.log('[CANCEL] load shiprocket order ids')
    const shipQ = await client.query(
      `SELECT DISTINCT shiprocket_order_id
       FROM shipments
       WHERE sale_id = $1::uuid
         AND shiprocket_order_id IS NOT NULL`,
      [sale_id]
    )

    shiprocketOrderIds = shipQ.rows.map(r => r.shiprocket_order_id).filter(Boolean)
    console.log('[CANCEL] shiprocketOrderIds', shiprocketOrderIds)

    console.log('[CANCEL] update sales')
    await client.query(
      `UPDATE sales
       SET status = $2
       WHERE id = $1::uuid`,
      [sale_id, 'CANCELLED']
    )

    console.log('[CANCEL] update shipments')
    await client.query(
      `UPDATE shipments
       SET status = $2
       WHERE sale_id = $1::uuid`,
      [sale_id, 'CANCELLED']
    )

    console.log('[CANCEL] insert into order_cancellations')
    await client.query(
      `INSERT INTO order_cancellations (sale_id, payment_type, reason, created_at)
       VALUES ($1::uuid, $2, $3, now())
       ON CONFLICT DO NOTHING`,
      [sale_id, payment_type || salePaymentStatus, reason || null]
    )

    await client.query('COMMIT')
    client.release()
    console.log('[CANCEL] transaction committed for', sale_id)
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch (_) {}
    client.release()
    console.error('[CANCEL] error', e)
    return res.status(500).json({
      ok: false,
      message: 'Failed to cancel order',
      error: e.message
    })
  }

  if (shiprocketOrderIds.length) {
    try {
      console.log('[CANCEL] calling Shiprocket cancel for', shiprocketOrderIds)
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
    reason: reason || null
  })
})

module.exports = router
