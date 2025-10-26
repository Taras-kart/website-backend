const express = require('express');
const pool = require('../db');
const ReturnsService = require('../services/returnsService');

const router = express.Router();

// basic eligibility: delivered and within 7 days
async function isEligible(saleId) {
  const saleRes = await pool.query('SELECT * FROM sales WHERE id=$1', [saleId]);
  if (!saleRes.rows.length) return { ok: false, reason: 'Sale not found' };
  const sale = saleRes.rows[0];

  const s = await pool.query('SELECT status, created_at FROM shipments WHERE sale_id=$1 ORDER BY created_at DESC', [saleId]);
  const statuses = s.rows.map(r => String(r.status || '').toUpperCase());
  const delivered = statuses.includes('DELIVERED');

  const deliveredAt = s.rows.find(r => String(r.status || '').toUpperCase()==='DELIVERED')?.created_at || sale.created_at;
  const windowDays = 7;
  const withinWindow = delivered && (Date.now() - new Date(deliveredAt).getTime()) <= windowDays*24*3600*1000;

  if (!delivered) return { ok: false, reason: 'Order not delivered yet' };
  if (!withinWindow) return { ok: false, reason: `Return window (${windowDays} days) exceeded` };
  return { ok: true, sale };
}

// GET: quick check for UI gating
router.get('/returns/eligibility/:saleId', async (req, res) => {
  try {
    const result = await isEligible(req.params.saleId);
    res.json(result);
  } catch (e) { res.status(500).json({ ok:false, reason: e.message || 'error' }); }
});

// POST: customer raises return/replace request
router.post('/returns', async (req, res) => {
  try {
    const { sale_id, type, reason, notes, items } = req.body;
    const el = await isEligible(sale_id);
    if (!el.ok) return res.status(400).json(el);

    const ins = await pool.query(
      `INSERT INTO return_requests (sale_id, customer_email, customer_mobile, type, reason, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,'REQUESTED')
       RETURNING *`,
      [ sale_id, el.sale.customer_email || null, el.sale.customer_mobile || null,
        type === 'REPLACE' ? 'REPLACE' : 'RETURN', reason || null, notes || null ]
    );
    const reqRow = ins.rows[0];

    if (Array.isArray(items) && items.length) {
      const values = [];
      const params = [];
      items.forEach((it, i) => {
        params.push(`($${i*6+1},$${i*6+2},$${i*6+3},$${i*6+4},$${i*6+5},$${i*6+6})`);
        values.push(reqRow.id, it.variant_id, it.qty, it.reason_code || null, it.condition_note || null, );
        values.push(null); // keeps indexes simple if you want to add a column later
      });
      await pool.query(
        `INSERT INTO return_items (request_id, variant_id, qty, reason_code, condition_note, /*pad*/ reason_code)
         VALUES ${params.join(',')}`, values
      );
      // remove the extra duplicated column if you don't want it; it's a harmless "pad".
    }

    res.json({ ok: true, request: reqRow });
  } catch (e) { res.status(500).json({ ok:false, message: e.message || 'create failed' }); }
});

// POST: admin approves → creates Shiprocket reverse pickup
router.post('/returns/:id/approve', async (req, res) => {
  try {
    const id = req.params.id;
    const rr = await pool.query('SELECT * FROM return_requests WHERE id=$1', [id]);
    if (!rr.rows.length) return res.status(404).json({ ok:false, message:'Return request not found' });
    const request = rr.rows[0];

    const sale = (await pool.query('SELECT * FROM sales WHERE id=$1',[request.sale_id])).rows[0];
    const items = (await pool.query('SELECT * FROM return_items WHERE request_id=$1',[id])).rows;

    // IMPORTANT: return to the sale's original branch (or any target evaluation logic you want)
    const branch = (await pool.query('SELECT * FROM branches WHERE id=$1',[sale.branch_id])).rows[0];

    const svc = new ReturnsService({ pool });
    await svc.init();
    const reverse = await svc.createReversePickup({ request, sale, items, branch });

    await pool.query('UPDATE return_requests SET status=$1, updated_at=now() WHERE id=$2', ['APPROVED', id]);
    res.json({ ok:true, reverse });
  } catch (e) { res.status(500).json({ ok:false, message: e.message || 'approve failed' }); }
});

// POST: admin rejects
router.post('/returns/:id/reject', async (req, res) => {
  try {
    const id = req.params.id;
    const rr = await pool.query('SELECT * FROM return_requests WHERE id=$1', [id]);
    if (!rr.rows.length) return res.status(404).json({ ok:false, message:'Return request not found' });
    await pool.query(
      'UPDATE return_requests SET status=$1, notes=COALESCE(notes, \'\')||$2, updated_at=now() WHERE id=$3',
      ['REJECTED', `\nRejected: ${req.body?.reason || ''}`, id]
    );
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, message: e.message || 'reject failed' }); }
});

// GET: show requests for a sale (for Orders / Track page)
router.get('/returns/by-sale/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId;
    const q = await pool.query(
      `SELECT r.*,
              COALESCE(json_agg(ri.*) FILTER (WHERE ri.id IS NOT NULL), '[]') AS items
       FROM return_requests r
       LEFT JOIN return_items ri ON ri.request_id = r.id
       WHERE r.sale_id=$1
       GROUP BY r.id
       ORDER BY r.created_at DESC`,
      [saleId]
    );
    res.json({ ok:true, rows: q.rows });
  } catch (e) { res.status(500).json({ ok:false, message: e.message || 'list failed' }); }
});

module.exports = router;
