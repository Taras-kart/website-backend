const express = require('express');
const pool = require('../db');
const { requireAuth, scopeBranch } = require('../middleware/auth');
const { sellingSql } = require('../utils/catalogue');

const router = express.Router();
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';

router.get('/:ean', requireAuth, async (req, res, next) => {
  const ean = String(req.params.ean || '').trim();
  if (!ean) return res.status(400).json({ message: 'ean required' });

  try {
    const branchId = scopeBranch(req);
    const { rows } = await pool.query(
      `SELECT
         b.ean_code,
         v.id AS variant_id,
         v.size,
         v.colour,
         v.fit,
         v.mrp::numeric AS mrp,
         ${sellingSql('B2C')} AS sale_price,
         (stock.on_hand-stock.reserved) AS available_qty,
         v.cost_price::numeric AS cost_price,
         p.id AS product_id,
         p.name AS product_name,
         p.brand_name,
         pci.image_url AS shared_image_url,
         v.image_url AS variant_image_url,
         pi.image_url AS ean_image_url,
         CASE
           WHEN NULLIF(pci.image_url, '') IS NOT NULL THEN 'shared'
           WHEN NULLIF(v.image_url, '') IS NOT NULL THEN 'variant'
           WHEN NULLIF(pi.image_url, '') IS NOT NULL THEN 'ean'
           ELSE 'cloudinary_ean'
         END AS image_source,
         COALESCE(
           NULLIF(pci.image_url, ''),
           NULLIF(v.image_url, ''),
           NULLIF(pi.image_url, ''),
           CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', b.ean_code)
         ) AS image_url
       FROM public.barcodes b
       JOIN public.product_variants v ON v.id = b.variant_id
       JOIN public.products p ON p.id = v.product_id
       JOIN public.branch_variant_stock stock ON stock.variant_id=v.id AND stock.branch_id=$3 AND stock.is_active=TRUE
       LEFT JOIN public.product_colour_images pci
         ON pci.product_id = p.id
        AND LOWER(BTRIM(pci.colour)) = LOWER(BTRIM(v.colour))
        AND LOWER(BTRIM(COALESCE(pci.fit, ''))) = LOWER(BTRIM(COALESCE(v.fit, '')))
       LEFT JOIN public.product_images pi ON pi.ean_code = b.ean_code AND pi.image_type='front'
       WHERE b.ean_code = $1 AND v.is_active=TRUE AND p.is_active=TRUE
       LIMIT 1`,
      [ean, CLOUD_NAME, branchId]
    );

    if (!rows.length) return res.status(404).json({ message: 'Barcode not found in this branch or product is inactive' });
    if (Number(rows[0].available_qty) <= 0) return res.status(409).json({ message: 'This product is out of stock at the selected branch' });

    const row = rows[0];
    return res.json({
      ean_code: row.ean_code,
      variant_id: Number(row.variant_id),
      available_qty: Number(row.available_qty),
      size: row.size,
      colour: row.colour,
      fit: row.fit,
      mrp: row.mrp !== null ? Number(row.mrp) : null,
      sale_price: row.sale_price !== null ? Number(row.sale_price) : null,
      cost_price: row.cost_price !== null ? Number(row.cost_price) : null,
      image_url: row.image_url || '',
      image_source: row.image_source,
      shared_image_url: row.shared_image_url || '',
      variant_image_url: row.variant_image_url || '',
      ean_image_url: row.ean_image_url || '',
      product_id: Number(row.product_id),
      product_name: row.product_name,
      brand_name: row.brand_name
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
