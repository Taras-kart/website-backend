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
         pv.image_url AS variant_image,
         p.id AS product_id,
         p.name AS product_name,
         p.brand_name,
         p.pattern_code,
         p.fit_type,
         p.mark_code,
         pi.image_url AS product_image
       FROM barcodes b
       JOIN product_variants pv ON pv.id = b.variant_id
       JOIN products p ON p.id = pv.product_id
       LEFT JOIN product_images pi ON pi.ean_code = b.ean_code
       WHERE b.ean_code = $1
       LIMIT 1`,
      [req.params.ean]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
