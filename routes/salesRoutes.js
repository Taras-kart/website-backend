const express = require('express')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { fulfillOrderWithShiprocket } = require('../services/orderFulfillment')

const router = express.Router()

const WEB_BRANCH_ID = (() => {
  const v = parseInt(process.env.WEB_BRANCH_ID || '', 10)
  return Number.isFinite(v) && v > 0 ? v : 2
})()

router.post('/web/place', async (req, res) => {
  const {
    customer_email,
    customer_name,
    customer_mobile,
    shipping_address,
    totals,
    items,
    branch_id,
    payment_status,
    login_email
  } = req.body || {}

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'items required' })
  }

  const finalPaymentStatus = String(payment_status || 'COD').toUpperCase()
  const resolvedBranchId = Number(branch_id || WEB_BRANCH_ID || 0) || null

  const client = await pool.connect()
  let saleId = null
  let saleTotals = null

  try {
    await client.query('BEGIN')

    let bagTotal = 0
    let discountTotal = 0
    for (const it of items) {
      const mrp = Number(it?.mrp ?? it?.price ?? 0)
      const price = Number(it?.price ?? 0)
      const qty = Number(it?.qty ?? 1)
      bagTotal += mrp * qty
      discountTotal += Math.max(mrp - price, 0) * qty
    }

    const couponPct = Number(totals?.couponPct ?? 0)
    const couponDiscount = Math.floor(((bagTotal - discountTotal) * couponPct) / 100)
    const convenience = Number(totals?.convenience ?? 0)
    const giftWrap = Number(totals?.giftWrap ?? 0)
    const payable = bagTotal - discountTotal - couponDiscount + convenience + giftWrap

    saleTotals = {
      bagTotal,
      discountTotal,
      couponPct,
      couponDiscount,
      convenience,
      giftWrap,
      payable
    }

    const baseTotals = totals ? JSON.stringify(totals) : JSON.stringify(saleTotals)
    const storedEmail = login_email || customer_email || null

    if (!resolvedBranchId) {
      await client.query('ROLLBACK')
      client.release()
      return res.status(400).json({ message: 'branch_id required' })
    }

    const agg = new Map()
    for (const it of items) {
      const vId = Number(it?.variant_id ?? it?.product_id)
      const qty = Number(it?.qty ?? 1)
      if (!vId || qty <= 0) continue
      agg.set(vId, (agg.get(vId) || 0) + qty)
    }

    for (const [vId, qty] of agg.entries()) {
      const stockQ = await client.query(
        'SELECT on_hand FROM branch_variant_stock WHERE branch_id=$1 AND variant_id=$2 FOR UPDATE',
        [resolvedBranchId, vId]
      )
      if (!stockQ.rowCount) {
        await client.query('ROLLBACK')
        client.release()
        return res.status(400).json({ message: `Stock not found for variant ${vId} in branch ${resolvedBranchId}` })
      }
      const onHand = Number(stockQ.rows[0].on_hand || 0)
      if (onHand < qty) {
        await client.query('ROLLBACK')
        client.release()
        return res.status(400).json({ message: `Insufficient stock for variant ${vId} in branch ${resolvedBranchId}` })
      }
    }

    for (const [vId, qty] of agg.entries()) {
      await client.query(
        'UPDATE branch_variant_stock SET on_hand = on_hand - $3 WHERE branch_id=$1 AND variant_id=$2',
        [resolvedBranchId, vId, qty]
      )
    }

    const inserted = await client.query(
      `INSERT INTO sales
       (source, customer_email, customer_name, customer_mobile, shipping_address, status, payment_status, totals, branch_id, total)
       VALUES
       ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10)
       RETURNING id`,
      [
        'WEB',
        storedEmail,
        customer_name || null,
        customer_mobile || null,
        shipping_address ? JSON.stringify(shipping_address) : null,
        'PLACED',
        finalPaymentStatus,
        baseTotals,
        resolvedBranchId,
        payable
      ]
    )

    saleId = inserted.rows[0].id

    for (const it of items) {
      await client.query(
        `INSERT INTO sale_items
         (sale_id, variant_id, qty, price, mrp, size, colour, image_url, ean_code)
         VALUES
         ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          saleId,
          Number(it?.variant_id ?? it?.product_id),
          Number(it?.qty ?? 1),
          Number(it?.price ?? 0),
          it?.mrp != null ? Number(it.mrp) : null,
          it?.size ?? it?.selected_size ?? null,
          it?.colour ?? it?.color ?? it?.selected_color ?? null,
          it?.image_url ?? null,
          it?.ean_code ?? it?.barcode_value ?? null
        ]
      )
    }

    await client.query('COMMIT')
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    try {
      client.release()
    } catch {}
    return res.status(500).json({ message: 'Server error' })
  } finally {
    try {
      client.release()
    } catch {}
  }

  const responseTotals = saleTotals || totals || null

  let shiprocket = null
  let shiprocket_error = null

  if (saleId && responseTotals && Number(responseTotals.payable || 0) > 0) {
    const saleForShiprocket = {
      id: saleId,
      branch_id: resolvedBranchId,
      customer_email: login_email || customer_email || null,
      customer_name: customer_name || null,
      customer_mobile: customer_mobile || null,
      shipping_address,
      totals: responseTotals,
      payment_status: finalPaymentStatus,
      pincode: shipping_address?.pincode || null,
      items: items.map(it => ({
        variant_id: Number(it?.variant_id ?? it?.product_id),
        qty: Number(it?.qty ?? 1),
        price: Number(it?.price ?? 0),
        mrp: it?.mrp != null ? Number(it.mrp) : Number(it?.price ?? 0),
        size: it?.size ?? it?.selected_size ?? null,
        colour: it?.colour ?? it?.color ?? it?.selected_color ?? null,
        image_url: it?.image_url ?? null,
        ean_code: it?.ean_code ?? it?.barcode_value ?? null,
        name: it?.name ?? it?.product_name ?? null
      }))
    }

    try {
      shiprocket = await fulfillOrderWithShiprocket(saleForShiprocket, pool)
    } catch (err) {
      shiprocket_error = err?.response?.data || err?.message || String(err)
    }
  }

  return res.json({
    id: saleId,
    status: 'PLACED',
    totals: responseTotals,
    shiprocket,
    shiprocket_error
  })
})

router.post('/web/set-payment-status', async (req, res) => {
  const client = await pool.connect()
  let newStatus = null

  try {
    const requestedSaleId = String(req.body.sale_id || '').trim()
    const status = String(req.body.status || '').trim().toUpperCase()
    if (!requestedSaleId || !status) {
      client.release()
      return res.status(400).json({ message: 'sale_id and status required' })
    }
    if (!['COD', 'PENDING', 'PAID', 'FAILED'].includes(status)) {
      client.release()
      return res.status(400).json({ message: 'invalid status' })
    }

    await client.query('BEGIN')

    const saleQ = await client.query(
      `SELECT id,
              payment_status,
              branch_id,
              customer_name,
              customer_email,
              customer_mobile,
              shipping_address,
              totals
       FROM sales
       WHERE id = $1::uuid
       FOR UPDATE`,
      [requestedSaleId]
    )
    if (!saleQ.rowCount) {
      await client.query('ROLLBACK')
      client.release()
      return res.status(404).json({ message: 'Sale not found' })
    }

    const saleRow = saleQ.rows[0]
    const currentStatus = String(saleRow.payment_status || '').toUpperCase()

    if (currentStatus === status) {
      await client.query('COMMIT')
      client.release()
      return res.json({ id: saleRow.id, payment_status: currentStatus })
    }

    const q = await client.query(
      'UPDATE sales SET payment_status=$2, updated_at=now() WHERE id=$1::uuid RETURNING id, payment_status',
      [saleRow.id, status]
    )

    await client.query('COMMIT')
    client.release()

    newStatus = q.rows[0].payment_status

    return res.json({ id: q.rows[0].id, payment_status: newStatus })
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {}
    try {
      client.release()
    } catch {}
    return res.status(500).json({ message: 'Server error' })
  }
})

router.get('/web', async (_req, res) => {
  try {
    const list = await pool.query(
      `SELECT
         s.*,
         oc.payment_type AS cancellation_payment_type,
         oc.reason AS cancellation_reason,
         oc.cancellation_source,
         oc.created_at AS cancellation_created_at
       FROM sales s
       LEFT JOIN order_cancellations oc
         ON oc.sale_id = s.id
       ORDER BY s.created_at DESC NULLS LAST, s.id DESC
       LIMIT 200`
    )
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    return res.json(list.rows)
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.get('/web/by-user', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim()
    const mobile = String(req.query.mobile || '').trim()
    if (!email && !mobile) {
      return res.status(400).json({ message: 'email or mobile required' })
    }

    const params = []
    const conds = ["s.source = 'WEB'"]
    const ors = []

    if (email) {
      params.push(email)
      ors.push(`LOWER(s.customer_email) = LOWER($${params.length})`)
    }
    if (mobile) {
      params.push(mobile)
      ors.push(
        `regexp_replace(s.customer_mobile,'\\D','','g') = regexp_replace($${params.length},'\\D','','g')`
      )
    }
    if (ors.length) conds.push(`(${ors.join(' OR ')})`)

    const salesQ = await pool.query(
      `SELECT
         s.id,
         s.status,
         s.payment_status,
         s.created_at,
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
       WHERE ${conds.join(' AND ')}
       ORDER BY s.created_at DESC NULLS LAST, s.id DESC
       LIMIT 200`,
      params
    )

    if (salesQ.rowCount === 0) return res.json([])

    const ids = salesQ.rows.map(r => r.id)
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'

    const itemsQ = await pool.query(
      `SELECT
         si.sale_id,
         si.variant_id,
         si.qty,
         si.price,
         si.mrp,
         si.size,
         si.colour,
         si.ean_code,
         COALESCE(
           NULLIF(si.image_url,''),
           NULLIF(pi.image_url,''),
           CASE
             WHEN si.ean_code IS NOT NULL AND si.ean_code <> ''
             THEN CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', si.ean_code)
             ELSE NULL
           END
         ) AS image_url,
         p.name  AS product_name,
         p.brand_name
       FROM sale_items si
       LEFT JOIN product_variants v ON v.id = si.variant_id
       LEFT JOIN products p ON p.id = v.product_id
       LEFT JOIN product_images pi ON pi.ean_code = si.ean_code
       WHERE si.sale_id = ANY($1::uuid[])`,
      [ids, cloud]
    )

    const bySale = new Map()
    for (const s of salesQ.rows) bySale.set(s.id, { ...s, items: [] })
    for (const it of itemsQ.rows) {
      const rec = bySale.get(it.sale_id)
      if (rec) {
        rec.items.push({
          variant_id: it.variant_id,
          qty: Number(it.qty || 0),
          price: Number(it.price || 0),
          mrp: it.mrp != null ? Number(it.mrp) : null,
          size: it.size,
          colour: it.colour,
          ean_code: it.ean_code,
          image_url: it.image_url,
          product_name: it.product_name,
          brand_name: it.brand_name
        })
      }
    }

    res.json(Array.from(bySale.values()))
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.get('/web/:id', async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'id required' })
  try {
    const s = await pool.query(
      `SELECT
         s.id,
         s.status,
         s.payment_status,
         s.created_at,
         s.totals,
         s.branch_id,
         s.customer_name,
         s.customer_email,
         s.customer_mobile,
         s.shipping_address,
         oc.payment_type AS cancellation_payment_type,
         oc.reason AS cancellation_reason,
         oc.cancellation_source,
         oc.created_at AS cancellation_created_at
       FROM sales s
       LEFT JOIN order_cancellations oc
         ON oc.sale_id = s.id
       WHERE s.id = $1::uuid`,
      [id]
    )
    if (!s.rowCount) return res.status(404).json({ message: 'Not found' })

    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'

    const itemsQ = await pool.query(
      `SELECT
         si.variant_id,
         si.qty,
         si.price,
         si.mrp,
         si.size,
         si.colour,
         si.ean_code,
         COALESCE(
           NULLIF(si.image_url,''),
           NULLIF(pi.image_url,''),
           CASE
             WHEN si.ean_code IS NOT NULL AND si.ean_code <> ''
             THEN CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', si.ean_code)
             ELSE NULL
           END
         ) AS image_url,
         p.name  AS product_name,
         p.brand_name
       FROM sale_items si
       LEFT JOIN product_variants v ON v.id = si.variant_id
       LEFT JOIN products p ON p.id = v.product_id
       LEFT JOIN product_images pi ON pi.ean_code = si.ean_code
       WHERE si.sale_id = $1::uuid`,
      [id, cloud]
    )

    const items = itemsQ.rows.map(r => ({
      variant_id: r.variant_id,
      qty: Number(r.qty || 0),
      price: Number(r.price || 0),
      mrp: r.mrp != null ? Number(r.mrp) : null,
      size: r.size,
      colour: r.colour,
      ean_code: r.ean_code,
      image_url: r.image_url,
      product_name: r.product_name,
      brand_name: r.brand_name
    }))

    return res.json({ sale: s.rows[0], items })
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.get('/admin', requireAuth, async (req, res) => {
  try {
    const role = String(req.user?.role_enum || '').toUpperCase()
    const isSuper = role === 'SUPER_ADMIN'
    const branchId = Number(req.user?.branch_id || 0)

    const params = []
    const where = []

    if (!isSuper) {
      if (!branchId) return res.status(403).json({ message: 'Forbidden' })
      params.push(branchId)
      where.push(`s.branch_id = $${params.length}`)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const list = await pool.query(
      `SELECT
         s.*,
         oc.payment_type AS cancellation_payment_type,
         oc.reason AS cancellation_reason,
         oc.cancellation_source,
         oc.created_at AS cancellation_created_at
       FROM sales s
       LEFT JOIN order_cancellations oc
         ON oc.sale_id = s.id
       ${whereSql}
       ORDER BY s.created_at DESC NULLS LAST, s.id DESC
       LIMIT 200`,
      params
    )

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    return res.json(list.rows)
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.get('/admin/:id', requireAuth, async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'id required' })

  try {
    const role = String(req.user?.role_enum || '').toUpperCase()
    const isSuper = role === 'SUPER_ADMIN'
    const branchId = Number(req.user?.branch_id || 0)

    const params = [id]
    let where = `s.id = $1::uuid`

    if (!isSuper) {
      if (!branchId) return res.status(403).json({ message: 'Forbidden' })
      params.push(branchId)
      where += ` AND s.branch_id = $2`
    }

    const s = await pool.query(
      `SELECT
         s.id,
         s.status,
         s.payment_status,
         s.created_at,
         s.totals,
         s.branch_id,
         s.customer_name,
         s.customer_email,
         s.customer_mobile,
         s.shipping_address,
         oc.payment_type AS cancellation_payment_type,
         oc.reason AS cancellation_reason,
         oc.cancellation_source,
         oc.created_at AS cancellation_created_at
       FROM sales s
       LEFT JOIN order_cancellations oc
         ON oc.sale_id = s.id
       WHERE ${where}`,
      params
    )
    if (!s.rowCount) return res.status(404).json({ message: 'Not found' })

    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'

    const itemsQ = await pool.query(
      `SELECT
         si.variant_id,
         si.qty,
         si.price,
         si.mrp,
         si.size,
         si.colour,
         si.ean_code,
         COALESCE(
           NULLIF(si.image_url,''),
           NULLIF(pi.image_url,''),
           CASE
             WHEN si.ean_code IS NOT NULL AND si.ean_code <> ''
             THEN CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', si.ean_code)
             ELSE NULL
           END
         ) AS image_url,
         p.name  AS product_name,
         p.brand_name
       FROM sale_items si
       LEFT JOIN product_variants v ON v.id = si.variant_id
       LEFT JOIN products p ON p.id = v.product_id
       LEFT JOIN product_images pi ON pi.ean_code = si.ean_code
       WHERE si.sale_id = $1::uuid`,
      [id, cloud]
    )

    const items = itemsQ.rows.map(r => ({
      variant_id: r.variant_id,
      qty: Number(r.qty || 0),
      price: Number(r.price || 0),
      mrp: r.mrp != null ? Number(r.mrp) : null,
      size: r.size,
      colour: r.colour,
      ean_code: r.ean_code,
      image_url: r.image_url,
      product_name: r.product_name,
      brand_name: r.brand_name
    }))

    return res.json({ sale: s.rows[0], items })
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.post('/confirm', requireAuth, async (req, res) => {
  const { sale_id, branch_id, payment, items, client_action_id } = req.body || {}
  const branchId = Number(branch_id || req.user.branch_id)
  if (!sale_id || !branchId || !Array.isArray(items) || !items.length || !client_action_id) {
    return res
      .status(400)
      .json({ message: 'sale_id, branch_id, items[], client_action_id required' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const idem = await client.query('SELECT key FROM idempotency_keys WHERE key = $1', [
      client_action_id
    ])
    if (idem.rowCount) {
      const s = await client.query('SELECT id, status, total FROM sales WHERE id = $1::uuid', [
        sale_id
      ])
      await client.query('COMMIT')
      return res.json({
        id: sale_id,
        status: s.rows[0]?.status || 'confirmed',
        total: s.rows[0]?.total || 0,
        idempotent: true
      })
    }

    let total = 0
    for (const it of items) total += Number(it?.qty ?? 0) * Number(it?.price ?? 0)

    const s0 = await client.query('SELECT id FROM sales WHERE id = $1::uuid', [sale_id])
    if (!s0.rowCount) {
      await client.query(
        `INSERT INTO sales (id, branch_id, status, total, payment_method, payment_ref)
         VALUES ($1::uuid,$2,'pending',$3,$4,$5)`,
        [sale_id, branchId, total, payment?.method || null, payment?.ref || null]
      )
    } else {
      await client.query('UPDATE sales SET total = $2 WHERE id = $1::uuid', [sale_id, total])
    }

    for (const it of items) {
      const vId = Number(it?.variant_id ?? it?.product_id)
      const qty = Number(it?.qty ?? 0)
      const s1 = await client.query(
        'SELECT on_hand, reserved FROM branch_variant_stock WHERE branch_id = $1 AND variant_id = $2 FOR UPDATE',
        [branchId, vId]
      )
      if (!s1.rowCount) {
        await client.query('ROLLBACK')
        return res.status(404).json({ message: `Variant ${vId} not found in branch` })
      }
      await client.query(
        'UPDATE branch_variant_stock SET reserved = GREATEST(reserved - $3, 0) WHERE branch_id = $1 AND variant_id = $2',
        [branchId, vId, qty]
      )
    }

    await client.query('DELETE FROM sale_items WHERE sale_id = $1::uuid', [sale_id])
    for (const it of items) {
      await client.query(
        'INSERT INTO sale_items (sale_id, variant_id, ean_code, qty, price) VALUES ($1::uuid,$2,$3,$4,$5)',
        [
          sale_id,
          Number(it?.variant_id ?? it?.product_id),
          it?.barcode_value ?? it?.ean_code ?? null,
          Number(it?.qty ?? 0),
          Number(it?.price ?? 0)
        ]
      )
    }

    await client.query('UPDATE sales SET status = $2 WHERE id = $1::uuid', [sale_id, 'confirmed'])
    await client.query('INSERT INTO idempotency_keys (key) VALUES ($1)', [client_action_id])

    await client.query('COMMIT')
    return res.json({ id: sale_id, status: 'confirmed', total })
  } catch {
    await client.query('ROLLBACK')
    return res.status(500).json({ message: 'Server error' })
  } finally {
    client.release()
  }
})

module.exports = router
