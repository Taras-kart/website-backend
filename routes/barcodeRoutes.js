const express = require('express');
const pool = require('../db');

const router = express.Router();

router.get('/:ean', async (req, res) => {
  const ean = String(req.params.ean || '').trim();
  if (!ean) return res.status(400).json({ message: 'ean required' });
  try {
    const { rows } = await pool.query(
      `
      SELECT
        b.ean_code,
        pv.id AS variant_id,
        pv.size,
        pv.colour,
        pv.mrp::numeric,
        pv.sale_price::numeric,
        pv.cost_price::numeric,
        COALESCE(pv.image_url, pi.image_url, '') AS image_url,
        p.id AS product_id,
        p.name AS product_name,
        p.brand_name
      FROM public.barcodes b
      JOIN public.product_variants pv ON pv.id = b.variant_id
      JOIN public.products p ON p.id = pv.product_id
      LEFT JOIN public.product_images pi ON pi.ean_code = b.ean_code
      WHERE b.ean_code = $1
      LIMIT 1
      `,
      [ean]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    return res.json(rows[0]);
  } catch {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
