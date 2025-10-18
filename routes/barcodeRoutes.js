const express = require('express');
const pool = require('../db');
const router = express.Router();

router.get('/:ean', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
         b.ean_code,
         pv.id AS variant_id,
         pv.size,
         pv.colour,
         pv.mrp,
         pv.sale_price,
         pv.cost_price,
         p.id AS product_id,
         p.name AS product_name,
         p.brand_name
       FROM public.barcodes b
       JOIN public.product_variants pv ON pv.id = b.variant_id
       JOIN public.products p ON p.id = pv.product_id
       WHERE b.ean_code = $1
       LIMIT 1`,
      [req.params.ean]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
