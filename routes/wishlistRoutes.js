const express = require('express');
const pool = require('../db');
const router = express.Router();

router.post('/', async (req, res) => {
  const { user_id, product_id } = req.body;
  if (!user_id || !product_id) {
    return res.status(400).json({ message: 'User ID and Product ID are required' });
  }
  try {
    const prod = await pool.query('SELECT 1 FROM products WHERE id = $1', [product_id]);
    if (!prod.rowCount) {
      return res.status(400).json({ message: 'Invalid product_id (no such product)' });
    }
    await pool.query(
      `INSERT INTO taraswishlist (user_id, product_id)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM taraswishlist WHERE user_id = $1 AND product_id = $2
       )`,
      [user_id, product_id]
    );
    res.json({ message: 'Added to wishlist' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/:user_id', async (req, res) => {
  const userId = req.params.user_id;
  try {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';
    const { rows } = await pool.query(
      `
      WITH pv AS (
        SELECT DISTINCT ON (p.id)
          p.id AS product_id,
          p.name AS product_name,
          p.brand_name AS brand,
          p.gender AS gender,
          v.id AS variant_id,
          v.mrp::numeric AS mrp,
          v.sale_price::numeric AS sale_price,
          COALESCE(NULLIF(v.cost_price,0), 0)::numeric AS cost_price,
          COALESCE(bc_self.ean_code, bc_any.ean_code, '') AS ean_code,
          v.image_url AS v_image,
          pi.image_url AS pi_image
        FROM products p
        JOIN product_variants v ON v.product_id = p.id
        LEFT JOIN LATERAL (
          SELECT ean_code FROM barcodes b WHERE b.variant_id = v.id ORDER BY id ASC LIMIT 1
        ) bc_self ON TRUE
        LEFT JOIN LATERAL (
          SELECT b2.ean_code
          FROM product_variants v2
          JOIN products p2 ON p2.id = v2.product_id
          JOIN barcodes b2 ON b2.variant_id = v2.id
          WHERE p2.name = p.name AND p2.brand_name = p.brand_name AND v2.size = v.size AND v2.colour = v.colour
          ORDER BY b2.id ASC
          LIMIT 1
        ) bc_any ON TRUE
        LEFT JOIN product_images pi ON pi.ean_code = COALESCE(bc_self.ean_code, bc_any.ean_code)
        ORDER BY
          p.id,
          CASE
            WHEN COALESCE(NULLIF(v.image_url, ''), NULLIF(pi.image_url, ''), NULLIF(COALESCE(bc_self.ean_code, bc_any.ean_code, ''), '')) IS NOT NULL THEN 0
            ELSE 1
          END,
          v.id DESC
      )
      SELECT
        w.user_id,
        pv.product_id AS id,
        pv.product_id,
        pv.product_name,
        pv.brand,
        pv.gender,
        pv.mrp           AS original_price_b2c,
        pv.sale_price    AS final_price_b2c,
        pv.mrp           AS original_price_b2b,
        COALESCE(NULLIF(pv.cost_price,0), pv.sale_price) AS final_price_b2b,
        COALESCE(
          NULLIF(pv.v_image,''),
          NULLIF(pv.pi_image,''),
          CASE
            WHEN pv.ean_code <> '' THEN CONCAT('https://res.cloudinary.com/', $1::text, '/image/upload/f_auto,q_auto/products/', pv.ean_code)
            ELSE '/images/placeholder.jpg'
          END
        ) AS image_url
      FROM taraswishlist w
      JOIN pv ON pv.product_id = w.product_id
      WHERE w.user_id = $2
      ORDER BY pv.product_id DESC
      `,
      [cloud, userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching wishlist', error: err.message });
  }
});

router.delete('/', async (req, res) => {
  const { user_id, product_id } = req.body;
  if (!user_id || !product_id) {
    return res.status(400).json({ message: 'User ID and Product ID are required' });
  }
  try {
    await pool.query('DELETE FROM taraswishlist WHERE user_id = $1 AND product_id = $2', [user_id, product_id]);
    res.json({ message: 'Removed from wishlist' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
