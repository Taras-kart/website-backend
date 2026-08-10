const router = require('express').Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { getTracking } = require('../controllers/orderController')
const Shiprocket = require('../services/shiprocketService')

async function resolveVariantImage(db, variantId) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'
  const q = await db.query(
    `SELECT
       v.id AS variant_id,
       v.product_id,
       v.size,
       v.colour,
       v.fit,
       COALESCE(bc.ean_code, '') AS ean_code,
       NULLIF(pci.image_url, '') AS shared_image_url,
       COALESCE(
         NULLIF(v.image_url, ''),
         NULLIF(pi.image_url, ''),
         CASE
           WHEN COALESCE(bc.ean_code, '') <> ''
           THEN CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', bc.ean_code)
           ELSE NULL
         END
       ) AS fallback_image_url
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     LEFT JOIN product_colour_images pci
       ON pci.product_id = p.id
      AND LOWER(BTRIM(pci.colour)) = LOWER(BTRIM(v.colour))
      AND LOWER(BTRIM(COALESCE(pci.fit, ''))) = LOWER(BTRIM(COALESCE(v.fit, '')))
     LEFT JOIN LATERAL (
       SELECT ean_code
       FROM barcodes b
       WHERE b.variant_id = v.id
       ORDER BY b.id ASC
       LIMIT 1
     ) bc ON TRUE
     LEFT JOIN product_images pi ON pi.ean_code = bc.ean_code
     WHERE v.id = $1
     LIMIT 1`,
    [variantId, cloud]
  )
  return q.rows[0] || null
}

router.post('/web/place', async (req, res) => {
  const body = req.body || {}
  const items = Array.isArray(body.items) ? body.items : []
  const totals = body.totals && typeof body.totals === 'object' ? body.totals : null
  const shipping_address =
    body.shipping_address && typeof body.shipping_address === 'object'
      ? body.shipping_address
      : null

  const customer_name = body.customer_name ? String(body.customer_name) : null
  const customer_email = body.customer_email ? String(body.customer_email) : null
  const customer_mobile = body.customer_mobile ? String(body.customer_mobile) : null
  const payment_method = body.payment_method ? String(body.payment_method) : 'COD'
  const payment_status = body.payment_status ? String(body.payment_status) : 'COD'
  const login_email = body.login_email ? String(body.login_email) : null

  if (!items.length) return res.status(400).json({ message: 'Items required' })
  if (!shipping_address) return res.status(400).json({ message: 'shipping_address required' })

  const normalizedItems = items.map((it) => ({
    product_id: it.product_id != null ? Number(it.product_id) : null,
    variant_id: it.variant_id != null ? Number(it.variant_id) : null,
    qty: Number(it.qty || 1) || 1,
    price: Number(it.price || 0) || 0,
    mrp: Number(it.mrp || it.price || 0) || 0,
    size: it.size != null ? String(it.size) : null,
    colour: it.colour != null ? String(it.colour) : null,
    image_url: it.image_url != null ? String(it.image_url) : null,
    ean_code: it.ean_code != null ? String(it.ean_code) : it.barcode_value != null ? String(it.barcode_value) : null
  }))

  if (normalizedItems.some((it) => !it.variant_id || it.qty <= 0)) {
    return res.status(400).json({ message: 'Invalid items (variant_id/qty)' })
  }

  const agg = new Map()
  for (const it of normalizedItems) {
    agg.set(it.variant_id, (agg.get(it.variant_id) || 0) + it.qty)
  }

  const variantIds = Array.from(agg.keys())
  const providedBranchId = Number(body.branch_id || 0) || null

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let chosenBranchId = providedBranchId

    for (const vId of variantIds) {
      const qty = Number(agg.get(vId) || 0)
      const stockQ = await client.query(
        `SELECT SUM(GREATEST(COALESCE(on_hand, 0) - COALESCE(reserved, 0), 0)) AS avail,
                MAX(branch_id) AS sample_branch
         FROM branch_variant_stock
         WHERE variant_id = $1 AND is_active = true`,
        [vId]
      )

      const avail = Number(stockQ.rows[0]?.avail || 0)
      if (avail < qty) {
        await client.query('ROLLBACK')
        return res.status(400).json({ message: `Insufficient stock. Only ${avail} left globally for this variant.` })
      }

      if (!chosenBranchId && stockQ.rows[0]?.sample_branch) {
        chosenBranchId = stockQ.rows[0].sample_branch
      }
    }

    if (!chosenBranchId) chosenBranchId = 1

    const totalPayable = totals && totals.payable != null ? Number(totals.payable) : null

    const saleQ = await client.query(
      `INSERT INTO sales
        (source, status, payment_status, payment_method, total, totals, branch_id,
         customer_name, customer_email, customer_mobile, shipping_address, login_email, created_at)
       VALUES
        ('WEB', 'PLACED', $1, $2, $3, $4::jsonb, $5,
         $6, $7, $8, $9::jsonb, $10, now())
       RETURNING id`,
      [
        payment_status,
        payment_method,
        Number.isFinite(totalPayable) ? totalPayable : 0,
        JSON.stringify(totals || {}),
        chosenBranchId,
        customer_name,
        customer_email,
        customer_mobile,
        JSON.stringify(shipping_address || {}),
        login_email
      ]
    )

    const saleId = saleQ.rows?.[0]?.id || null
    if (!saleId) {
      await client.query('ROLLBACK')
      return res.status(500).json({ message: 'Failed to create order' })
    }

    for (const it of normalizedItems) {
      const resolved = await resolveVariantImage(client, it.variant_id)
      if (!resolved) {
        await client.query('ROLLBACK')
        return res.status(400).json({ message: `Invalid variant ${it.variant_id}` })
      }

      const providedImage = String(it.image_url || '').trim()
      const itemImage = resolved.shared_image_url || providedImage || resolved.fallback_image_url || null
      const itemProductId = Number(resolved.product_id) || null
      const itemSize = it.size || resolved.size || null
      const itemColour = it.colour || resolved.colour || null
      const itemEan = String(it.ean_code || '').trim() || resolved.ean_code || null

      await client.query(
        `INSERT INTO sale_items
          (sale_id, product_id, variant_id, qty, price, mrp, size, colour, image_url, ean_code, created_at)
         VALUES
          ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
        [
          saleId,
          itemProductId,
          it.variant_id,
          it.qty,
          it.price,
          it.mrp,
          itemSize,
          itemColour,
          itemImage,
          itemEan
        ]
      )
    }

    await client.query('COMMIT')
    return res.json({ id: saleId, branch_id: chosenBranchId })
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    return res.status(500).json({ message: 'Server error' })
  } finally {
    client.release()
  }
})

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
         s.source,
         s.status,
         s.payment_status,
         s.payment_method,
         s.payment_ref,
         s.created_at,
         s.total,
         s.totals,
         s.branch_id,
         s.customer_name,
         s.customer_email,
         s.customer_mobile,
         oc.payment_type AS cancellation_payment_type,
         oc.reason AS cancellation_reason,
         oc.cancellation_source,
         oc.created_at AS cancellation_created_at
       FROM sales s
       LEFT JOIN order_cancellations oc
         ON oc.sale_id = s.id
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

    shiprocketOrderIds = shipQ.rows.map((r) => r.shiprocket_order_id).filter(Boolean)

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
    try {
      await client.query('ROLLBACK')
    } catch {}
    try {
      client.release()
    } catch {}
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
