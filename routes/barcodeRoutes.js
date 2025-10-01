const express = require('express');
const pool = require('../db');
const router = express.Router();

router.get('/:ean', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pv.*, p.name AS product_name, p.brand_name
       FROM barcodes b
       JOIN product_variants pv ON pv.id = b.variant_id
       JOIN products p ON p.id = pv.product_id
       WHERE b.ean_code = $1`,
      [req.params.ean]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
