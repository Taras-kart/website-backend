const express = require('express')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()

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

  const client = await pool.connect()
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

    const baseTotals = totals
      ? JSON.stringify(totals)
      : JSON.stringify({ bagTotal, discountTotal, couponPct, couponDiscount, convenience, giftWrap, payable })

    const storedEmail = login_email || customer_email || null

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
        payment_status || 'COD',
        baseTotals,
        branch_id || null,
        payable
      ]
    )

    const saleId = inserted.rows[0].id

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
    return res.json({
      id: saleId,
      status: 'PLACED',
      totals: { bagTotal, discountTotal, couponPct, couponDiscount, convenience, giftWrap, payable }
    })
  } catch (e) {
    await client.query('ROLLBACK')
    return res.status(500).json({ message: 'Server error' })
  } finally {
    client.release()
  }
})

router.post('/web/set-payment-status', async (req, res) => {
  const client = await pool.connect()
  try {
    const saleId = String(req.body.sale_id || '').trim()
    const status = String(req.body.status || '').trim().toUpperCase()
    if (!saleId || !status) {
      client.release()
      return res.status(400).json({ message: 'sale_id and status required' })
    }
    if (!['COD', 'PENDING', 'PAID', 'FAILED'].includes(status)) {
      client.release()
      return res.status(400).json({ message: 'invalid status' })
    }

    await client.query('BEGIN')

    const saleQ = await client.query(
      'SELECT id, payment_status, branch_id FROM sales WHERE id = $1::uuid FOR UPDATE',
      [saleId]
    )
    if (!saleQ.rowCount) {
      await client.query('ROLLBACK')
      client.release()
      return res.status(404).json({ message: 'Sale not found' })
    }

    const currentStatus = String(saleQ.rows[0].payment_status || '').toUpperCase()
    const branchId = saleQ.rows[0].branch_id ? Number(saleQ.rows[0].branch_id) : null

    if (currentStatus === status) {
      await client.query('COMMIT')
      client.release()
      return res.json({ id: saleQ.rows[0].id, payment_status: currentStatus })
    }

    if (status === 'PAID' && currentStatus !== 'PAID' && branchId) {
      const itemsQ = await client.query(
        'SELECT variant_id, qty FROM sale_items WHERE sale_id = $1::uuid',
        [saleId]
      )

      if (itemsQ.rowCount) {
        for (const row of itemsQ.rows) {
          const vId = Number(row.variant_id)
          const qty = Number(row.qty || 0)
          if (!vId || qty <= 0) continue
          const stockQ = await client.query(
            'SELECT on_hand FROM branch_variant_stock WHERE branch_id = $1 AND variant_id = $2 FOR UPDATE',
            [branchId, vId]
          )
          if (!stockQ.rowCount) {
            await client.query('ROLLBACK')
            client.release()
            return res.status(400).json({ message: `Stock not found for variant ${vId}` })
          }
          const onHand = Number(stockQ.rows[0].on_hand || 0)
          if (onHand < qty) {
            await client.query('ROLLBACK')
            client.release()
            return res.status(400).json({ message: `Insufficient stock for variant ${vId}` })
          }
        }

        for (const row of itemsQ.rows) {
          const vId = Number(row.variant_id)
          const qty = Number(row.qty || 0)
          if (!vId || qty <= 0) continue
          await client.query(
            'UPDATE branch_variant_stock SET on_hand = on_hand - $3 WHERE branch_id = $1 AND variant_id = $2',
            [branchId, vId, qty]
          )
        }
      }
    }

    const q = await client.query(
      'UPDATE sales SET payment_status=$2, updated_at=now() WHERE id=$1::uuid RETURNING id, payment_status',
      [saleId, status]
    )

    await client.query('COMMIT')
    return res.json({ id: q.rows[0].id, payment_status: q.rows[0].payment_status })
  } catch {
    try {
      await pool.query('ROLLBACK')
    } catch {}
    return res.status(500).json({ message: 'Server error' })
  } finally {
    try {
      client.release()
    } catch {}
  }
})

router.get('/web', async (_req, res) => {
  try {
    const list = await pool.query(
      'SELECT * FROM sales WHERE source = $1 ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 50',
      ['WEB']
    )
    return res.json(list.rows)
  } catch {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.get('/web/by-user', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim()
    const mobile = String(req.query.mobile || '').trim()
    if (!email && !mobile) return res.status(400).json({ message: 'email or mobile required' })

    const params = []
    const conds = ["source = 'WEB'"]
    const ors = []

    if (email) {
      params.push(email)
      ors.push(`LOWER(customer_email) = LOWER($${params.length})`)
    }
    if (mobile) {
      params.push(mobile)
      ors.push(
        `regexp_replace(customer_mobile,'\\D','','g') = regexp_replace($${params.length},'\\D','','g')`
      )
    }
    if (ors.length) conds.push(`(${ors.join(' OR ')})`)

    const salesQ = await pool.query(
      `SELECT id, status, payment_status, created_at, totals, branch_id,
              customer_name, customer_email, customer_mobile
       FROM sales
       WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT 200`,
      params
    )

    if (salesQ.rowCount === 0) return res.json([])

    const ids = salesQ.rows.map((r) => r.id)
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
  } catch (e) {
    return res.status(500).json({ message: 'Server error' })
  }
})

router.get('/web/:id', async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'id required' })
  try {
    const s = await pool.query(
      `SELECT id, status, payment_status, created_at, totals, branch_id,
              customer_name, customer_email, customer_mobile, shipping_address
       FROM sales
       WHERE id = $1::uuid`,
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

router.post('/confirm', requireAuth, async (req, res) => {
  const { sale_id, branch_id, payment, items, client_action_id } = req.body || {}
  const branchId = Number(branch_id || req.user.branch_id)
  if (!sale_id || !branchId || !Array.isArray(items) || !items.length || !client_action_id) {
    return res.status(400).json({ message: 'sale_id, branch_id, items[], client_action_id required' })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const idem = await client.query('SELECT key FROM idempotency_keys WHERE key = $1', [client_action_id])
    if (idem.rowCount) {
      const s = await client.query('SELECT id, status, total FROM sales WHERE id = $1::uuid', [sale_id])
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
