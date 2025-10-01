const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.get('/variants', requireAuth, async (req, res) => {
  const branchId = Number(req.query.branch_id || req.user.branch_id);
  const q = String(req.query.q || '').trim();
  const args = [branchId];
  let where = '';
  if (q) {
    args.push(`%${q}%`);
    where = `AND (p.name ILIKE $2 OR p.brand_name ILIKE $2 OR pv.colour ILIKE $2 OR pv.size ILIKE $2)`;
  }
  try {
    const { rows } = await pool.query(
      `SELECT pv.id AS variant_id,
              p.id AS product_id,
              p.name AS product_name,
              p.brand_name,
              pv.size,
              pv.colour,
              bvs.on_hand,
              bvs.reserved
       FROM branch_variant_stock bvs
       JOIN product_variants pv ON pv.id = bvs.variant_id AND pv.is_active = TRUE
       JOIN products p ON p.id = pv.product_id
       WHERE bvs.branch_id = $1 AND bvs.is_active = TRUE
       ${where}
       ORDER BY p.name ASC, pv.size ASC, pv.colour ASC`,
      args
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
