const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.post('/confirm', requireAuth, async (req, res) => {
  const { sale_id, branch_id, payment, items, client_action_id } = req.body || {};
  const branchId = Number(branch_id || req.user.branch_id);
  if (!sale_id || !branchId || !Array.isArray(items) || !items.length || !client_action_id) {
    return res.status(400).json({ message: 'sale_id, branch_id, items[], client_action_id required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const idem = await client.query('SELECT key FROM idempotency_keys WHERE key = $1', [client_action_id]);
    if (idem.rowCount) {
      const s = await client.query('SELECT id, status, total FROM sales WHERE id = $1', [sale_id]);
      await client.query('COMMIT');
      return res.json({ id: sale_id, status: s.rows[0]?.status || 'confirmed', total: s.rows[0]?.total || 0, idempotent: true });
    }

    let total = 0;
    for (const it of items) total += Number(it.qty || 0) * Number(it.price || 0);

    const s0 = await client.query('SELECT id FROM sales WHERE id = $1', [sale_id]);
    if (!s0.rowCount) {
      await client.query(
        `INSERT INTO sales (id, branch_id, status, total, payment_method, payment_ref)
         VALUES ($1,$2,'pending',$3,$4,$5)`,
        [sale_id, branchId, total, payment?.method || null, payment?.ref || null]
      );
    } else {
      await client.query('UPDATE sales SET total = $2 WHERE id = $1', [sale_id, total]);
    }

    for (const it of items) {
      const vId = Number(it.variant_id || it.product_id);
      const qty = Number(it.qty || 0);
      const s1 = await client.query(
        'SELECT on_hand, reserved FROM branch_variant_stock WHERE branch_id = $1 AND variant_id = $2 FOR UPDATE',
        [branchId, vId]
      );
      if (!s1.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: `Variant ${vId} not found in branch` });
      }
      const cur = s1.rows[0];
      await client.query(
        'UPDATE branch_variant_stock SET reserved = GREATEST(reserved - $3, 0) WHERE branch_id = $1 AND variant_id = $2',
        [branchId, vId, qty]
      );
    }

    await client.query('DELETE FROM sale_items WHERE sale_id = $1', [sale_id]);
    for (const it of items) {
      await client.query(
        'INSERT INTO sale_items (sale_id, variant_id, ean_code, qty, price) VALUES ($1,$2,$3,$4,$5)',
        [sale_id, Number(it.variant_id || it.product_id), it.barcode_value || it.ean_code || null, Number(it.qty || 0), Number(it.price || 0)]
      );
    }

    await client.query('UPDATE sales SET status = $2 WHERE id = $1', [sale_id, 'confirmed']);
    await client.query('INSERT INTO idempotency_keys (key) VALUES ($1)', [client_action_id]);

    await client.query('COMMIT');
    res.json({ id: sale_id, status: 'confirmed', total });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
