const express = require('express')
const pool = require('../db')
const router = express.Router()

async function salesHasUserId(client) {
  const r = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name='sales' AND column_name='user_id' LIMIT 1"
  )
  return !!r.rowCount
}

async function findUserId(client, { login_email }) {
  if (!login_email) return null
  const q = await client.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1', [login_email])
  return q.rowCount ? q.rows[0].id : null
}

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
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ message: 'items required' })
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
    const hasUser = await salesHasUserId(client)
    const resolvedUserId = hasUser ? await findUserId(client, { login_email }) : null
    const baseTotals = totals
      ? JSON.stringify(totals)
      : JSON.stringify({ bagTotal, discountTotal, couponPct, couponDiscount, convenience, giftWrap, payable })
    const storedEmail = login_email || customer_email || null
    const insertQ = hasUser
      ? `INSERT INTO sales
         (source, user_id, customer_email, customer_name, customer_mobile, shipping_address, status, payment_status, totals, branch_id, total)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11)
         RETURNING id`
      : `INSERT INTO sales
         (source, customer_email, customer_name, customer_mobile, shipping_address, status, payment_status, totals, branch_id, total)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10)
         RETURNING id`
    const params = hasUser
      ? [
          'WEB',
          resolvedUserId,
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
      : [
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
    const inserted = await client.query(insertQ, params)
    const saleId = inserted.rows[0].id
    for (const it of items) {
      await client.query(
        `INSERT INTO sale_items
         (sale_id, variant_id, qty, price, mrp, size, colour, image_url, ean_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
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
    res.json({ id: saleId, status: 'PLACED', totals: { bagTotal, discountTotal, couponPct, couponDiscount, convenience, giftWrap, payable } })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('POST /api/sales/web/place error:', e)
    res.status(500).json({ message: 'Server error' })
  } finally {
    client.release()
  }
})

router.get('/web/by-user', async (req, res) => {
  const client = await pool.connect()
  try {
    const email = String(req.query.email || '').trim().toLowerCase()
    if (!email) return res.status(400).json({ message: 'email required' })
    const hasUser = await salesHasUserId(client)
    const userQ = await client.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1', [email])
    const userId = userQ.rowCount ? userQ.rows[0].id : null
    if (!userId) return res.json([])
    const salesQ = hasUser
      ? await client.query(
          `SELECT id,status,payment_status,created_at,totals,branch_id,customer_name,customer_email,customer_mobile
           FROM sales WHERE source='WEB' AND user_id=$1
           ORDER BY created_at DESC NULLS LAST,id DESC LIMIT 200`,
          [userId]
        )
      : await client.query(
          `SELECT id,status,payment_status,created_at,totals,branch_id,customer_name,customer_email,customer_mobile
           FROM sales WHERE source='WEB' AND LOWER(customer_email)=LOWER($1)
           ORDER BY created_at DESC NULLS LAST,id DESC LIMIT 200`,
          [email]
        )
    if (salesQ.rowCount === 0) return res.json([])
    const ids = salesQ.rows.map((r) => String(r.id))
    const idIsUuid = /^[0-9a-fA-F-]{36}$/.test(ids[0])
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh'
    const idParamType = idIsUuid ? 'uuid' : 'text'
    const itemsQ = await client.query(
      `SELECT
         si.sale_id,si.variant_id,si.qty,si.price,si.mrp,si.size,si.colour,si.ean_code,
         COALESCE(NULLIF(si.image_url,''),NULLIF(pi.image_url,''), 
           CASE WHEN si.ean_code IS NOT NULL AND si.ean_code<>'' 
           THEN CONCAT('https://res.cloudinary.com/',$2::text,'/image/upload/f_auto,q_auto/products/',si.ean_code)
           ELSE NULL END
         ) AS image_url,
         p.name AS product_name,p.brand_name
       FROM sale_items si
       LEFT JOIN product_variants v ON v.id=si.variant_id
       LEFT JOIN products p ON p.id=v.product_id
       LEFT JOIN product_images pi ON pi.ean_code=si.ean_code
       WHERE si.sale_id=ANY($1::${idParamType}[])`,
      [ids, cloud]
    )
    const bySale = new Map()
    for (const s of salesQ.rows) bySale.set(String(s.id), { ...s, items: [] })
    for (const it of itemsQ.rows) {
      const rec = bySale.get(String(it.sale_id))
      if (rec) rec.items.push(it)
    }
    res.json(Array.from(bySale.values()))
  } catch (e) {
    console.error('GET /api/sales/web/by-user error:', e)
    res.status(500).json({ message: 'Server error' })
  } finally {
    client.release()
  }
})

module.exports = router
