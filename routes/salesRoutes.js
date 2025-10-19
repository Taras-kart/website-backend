const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

async function salesHasUserId(client) {
  const r = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name='sales' AND column_name='user_id' LIMIT 1"
  );
  return !!r.rowCount;
}

async function findUserId(client, { login_email }) {
  if (!login_email) return null;
  const q = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [login_email]);
  return q.rowCount ? q.rows[0].id : null;
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
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'items required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let bagTotal = 0;
    let discountTotal = 0;
    for (const it of items) {
      const mrp = Number(it?.mrp ?? it?.price ?? 0);
      const price = Number(it?.price ?? 0);
      const qty = Number(it?.qty ?? 1);
      bagTotal += mrp * qty;
      discountTotal += Math.max(mrp - price, 0) * qty;
    }

    const couponPct = Number(totals?.couponPct ?? 0);
    const couponDiscount = Math.floor(((bagTotal - discountTotal) * couponPct) / 100);
    const convenience = Number(totals?.convenience ?? 0);
    const giftWrap = Number(totals?.giftWrap ?? 0);
    const payable = bagTotal - discountTotal - couponDiscount + convenience + giftWrap;

    const hasUser = await salesHasUserId(client);
    const resolvedUserId = hasUser ? await findUserId(client, { login_email }) : null;

    const baseTotals = totals
      ? JSON.stringify(totals)
      : JSON.stringify({ bagTotal, discountTotal, couponPct, couponDiscount, convenience, giftWrap, payable });

    let query, params;
    if (hasUser) {
      query = `
        INSERT INTO sales
        (source, user_id, customer_email, customer_name, customer_mobile, shipping_address, status, payment_status, totals, branch_id, total)
        VALUES
        ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11)
        RETURNING id
      `;
      params = [
        'WEB',
        resolvedUserId,
        login_email || customer_email || null,
        customer_name || null,
        customer_mobile || null,
        shipping_address ? JSON.stringify(shipping_address) : null,
        'PLACED',
        payment_status || 'COD',
        baseTotals,
        branch_id || null,
        payable
      ];
    } else {
      query = `
        INSERT INTO sales
        (source, customer_email, customer_name, customer_mobile, shipping_address, status, payment_status, totals, branch_id, total)
        VALUES
        ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10)
        RETURNING id
      `;
      params = [
        'WEB',
        login_email || customer_email || null,
        customer_name || null,
        customer_mobile || null,
        shipping_address ? JSON.stringify(shipping_address) : null,
        'PLACED',
        payment_status || 'COD',
        baseTotals,
        branch_id || null,
        payable
      ];
    }

    const inserted = await client.query(query, params);
    const saleId = inserted.rows[0].id;

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
      );
    }

    await client.query('COMMIT');
    return res.json({
      id: saleId,
      status: 'PLACED',
      totals: { bagTotal, discountTotal, couponPct, couponDiscount, convenience, giftWrap, payable }
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/sales/web/place error:', e);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
