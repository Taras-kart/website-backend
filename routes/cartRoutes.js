const express = require('express');
const pool = require('../db');
const router = express.Router();

const WEB_BRANCH_ID = (() => {
  const v = parseInt(process.env.WEB_BRANCH_ID || '', 10);
  return Number.isFinite(v) && v > 0 ? v : null;
})();

router.post('/tarascart', async (req, res) => {
  const { user_id, product_id, selected_size, selected_color } = req.body;
  if (!user_id || !product_id || !selected_size || !selected_color) {
    return res.status(400).json({ message: 'Missing cart fields' });
  }
  try {
    const upd = await pool.query(
      `UPDATE tarascart
       SET selected_size=$3, selected_color=$4, updated_at=CURRENT_TIMESTAMP
       WHERE user_id=$1 AND product_id=$2`,
      [user_id, product_id, selected_size, selected_color]
    );
    if (upd.rowCount === 0) {
      await pool.query(
        `INSERT INTO tarascart (user_id, product_id, selected_size, selected_color, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
        [user_id, product_id, selected_size, selected_color]
      );
    }
    res.status(201).json({ message: 'Added to cart successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Error adding to cart', error: err.message });
  }
});

router.get('/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';

    const sql = `
      WITH base AS (
        SELECT
          c.user_id,
          c.product_id            AS variant_id,
          c.selected_size,
          c.selected_color,
          v.product_id            AS product_id,
          p.name                  AS product_name,
          p.brand_name            AS brand,
          p.gender,
          v.size,
          v.colour                AS color,
          v.mrp::numeric          AS mrp,
          v.sale_price::numeric   AS sale_price,
          COALESCE(NULLIF(v.cost_price,0), 0)::numeric AS cost_price,
          COALESCE(v.b2c_discount_pct, 0)::numeric AS b2c_discount_pct,
          COALESCE(v.b2b_discount_pct, 0)::numeric AS b2b_discount_pct,
          COALESCE(bc_self.ean_code, bc_any.ean_code, '') AS ean_code,
          v.image_url             AS v_image,
          pi.image_url            AS pi_image
        FROM tarascart c
        JOIN product_variants v ON v.id = c.product_id
        JOIN products p ON p.id = v.product_id
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
        WHERE c.user_id = $1
      )
      SELECT
        user_id,
        variant_id AS id,
        product_id,
        product_name,
        brand,
        gender,
        color,
        size,
        selected_size,
        selected_color,
        mrp AS original_price_b2c,
        CASE
          WHEN b2c_discount_pct > 0
            THEN ROUND(mrp * (100 - b2c_discount_pct)::numeric / 100, 2)
          ELSE COALESCE(NULLIF(sale_price,0), mrp)
        END AS final_price_b2c,
        mrp AS original_price_b2b,
        CASE
          WHEN b2b_discount_pct > 0
            THEN ROUND(mrp * (100 - b2b_discount_pct)::numeric / 100, 2)
          ELSE COALESCE(NULLIF(cost_price,0), COALESCE(NULLIF(sale_price,0), mrp))
        END AS final_price_b2b,
        COALESCE(
          NULLIF(v_image,''),
          NULLIF(pi_image,''),
          CASE
            WHEN ean_code <> '' THEN CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', ean_code)
            ELSE NULL
          END
        ) AS image_url,
        ean_code
      FROM base
      ORDER BY variant_id DESC
    `;

    const { rows } = await pool.query(sql, [userId, cloud]);
    return res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching cart', error: err.message });
  }
});

router.delete('/tarascart', async (req, res) => {
  const { user_id, product_id } = req.body;
  if (!user_id || !product_id) {
    return res.status(400).json({ message: 'Missing fields for delete' });
  }
  try {
    await pool.query(`DELETE FROM tarascart WHERE user_id=$1 AND product_id=$2`, [user_id, product_id]);
    res.json({ message: 'Item removed from cart' });
  } catch (err) {
    res.status(500).json({ message: 'Error removing from cart', error: err.message });
  }
});

module.exports = router;
