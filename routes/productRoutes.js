const express = require('express');
const pool = require('../db');
const router = express.Router();

const toGender = (v) => {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'MEN' || s === 'WOMEN' || s === 'KIDS') return s;
  if (s === 'MAN' || s === 'MALE') return 'MEN';
  if (s === 'WOMAN' || s === 'FEMALE' || s === 'LADIES') return 'WOMEN';
  if (s === 'CHILD' || s === 'CHILDREN' || s === 'BOYS' || s === 'GIRLS') return 'KIDS';
  return '';
};

router.get('/', async (req, res) => {
  try {
    const genderQ = toGender(req.query.gender || req.query.category || '');
    const brand = req.query.brand ? String(req.query.brand).trim() : '';
    const q = req.query.q ? String(req.query.q).trim() : '';
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '200', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const params = [];
    let where = 'v.is_active = TRUE';
    if (genderQ) {
      params.push(genderQ);
      where += ` AND p.gender = $${params.length}`;
    }
    if (brand) {
      params.push(`%${brand}%`);
      where += ` AND p.brand_name ILIKE $${params.length}`;
    }
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (p.name ILIKE $${params.length} OR p.brand_name ILIKE $${params.length} OR v.colour ILIKE $${params.length})`;
    }
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';
    params.push(cloud);
    const cloudIdx = params.length;
    params.push(limit, offset);
    const sql = `
      SELECT
        v.id AS id,
        p.id AS product_id,
        p.name AS product_name,
        p.brand_name AS brand,
        p.gender AS gender,
        v.colour AS color,
        v.size AS size,
        v.mrp::numeric AS original_price_b2c,
        v.sale_price::numeric AS final_price_b2c,
        v.mrp::numeric AS original_price_b2b,
        COALESCE(NULLIF(v.cost_price,0), v.sale_price)::numeric AS final_price_b2b,
        v.mrp::numeric AS mrp,
        v.sale_price::numeric AS sale_price,
        COALESCE(NULLIF(v.cost_price,0), 0)::numeric AS cost_price,
        COALESCE(bc.ean_code,'') AS ean_code,
        COALESCE(
          NULLIF(v.image_url, ''),
          CASE
            WHEN COALESCE(bc.ean_code,'') <> '' THEN CONCAT('https://res.cloudinary.com/', $${cloudIdx}, '/image/upload/f_auto,q_auto/products/', LOWER(p.gender), '/', bc.ean_code)
            ELSE NULL
          END,
          CASE
            WHEN p.gender = 'WOMEN' THEN '/images/women/women20.jpeg'
            WHEN p.gender = 'MEN'   THEN '/images/men/default.jpg'
            WHEN p.gender = 'KIDS'  THEN '/images/kids/default.jpg'
            ELSE '/images/placeholder.jpg'
          END
        ) AS image_url
      FROM products p
      JOIN product_variants v ON v.product_id = p.id
      LEFT JOIN LATERAL (
        SELECT ean_code FROM barcodes b WHERE b.variant_id = v.id ORDER BY id ASC LIMIT 1
      ) bc ON TRUE
      WHERE ${where}
      ORDER BY v.id DESC
      LIMIT $${params.length-1} OFFSET $${params.length}
    `;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/category/:category', async (req, res) => {
  try {
    const g = toGender(req.params.category);
    const params = [];
    let where = 'v.is_active = TRUE';
    if (g) {
      params.push(g);
      where += ` AND p.gender = $${params.length}`;
    }
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';
    params.push(cloud);
    const cloudIdx = params.length;
    const sql = `
      SELECT
        v.id AS id,
        p.id AS product_id,
        p.name AS product_name,
        p.brand_name AS brand,
        p.gender AS gender,
        v.colour AS color,
        v.size AS size,
        v.mrp::numeric AS original_price_b2c,
        v.sale_price::numeric AS final_price_b2c,
        v.mrp::numeric AS original_price_b2b,
        COALESCE(NULLIF(v.cost_price,0), v.sale_price)::numeric AS final_price_b2b,
        v.mrp::numeric AS mrp,
        v.sale_price::numeric AS sale_price,
        COALESCE(NULLIF(v.cost_price,0), 0)::numeric AS cost_price,
        COALESCE(bc.ean_code,'') AS ean_code,
        COALESCE(
          NULLIF(v.image_url, ''),
          CASE
            WHEN COALESCE(bc.ean_code,'') <> '' THEN CONCAT('https://res.cloudinary.com/', $${cloudIdx}, '/image/upload/f_auto,q_auto/products/', LOWER(p.gender), '/', bc.ean_code)
            ELSE NULL
          END,
          CASE
            WHEN p.gender = 'WOMEN' THEN '/images/women/women20.jpeg'
            WHEN p.gender = 'MEN'   THEN '/images/men/default.jpg'
            WHEN p.gender = 'KIDS'  THEN '/images/kids/default.jpg'
            ELSE '/images/placeholder.jpg'
          END
        ) AS image_url
      FROM products p
      JOIN product_variants v ON v.product_id = p.id
      LEFT JOIN LATERAL (
        SELECT ean_code FROM barcodes b WHERE b.variant_id = v.id ORDER BY id ASC LIMIT 1
      ) bc ON TRUE
      WHERE ${where}
      ORDER BY v.id DESC
    `;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/gender/:gender', async (req, res) => {
  try {
    const g = toGender(req.params.gender);
    const params = [];
    let where = 'v.is_active = TRUE';
    if (g) {
      params.push(g);
      where += ` AND p.gender = $${params.length}`;
    }
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';
    params.push(cloud);
    const cloudIdx = params.length;
    const sql = `
      SELECT
        v.id AS id,
        p.id AS product_id,
        p.name AS product_name,
        p.brand_name AS brand,
        p.gender AS gender,
        v.colour AS color,
        v.size AS size,
        v.mrp::numeric AS original_price_b2c,
        v.sale_price::numeric AS final_price_b2c,
        v.mrp::numeric AS original_price_b2b,
        COALESCE(NULLIF(v.cost_price,0), v.sale_price)::numeric AS final_price_b2b,
        v.mrp::numeric AS mrp,
        v.sale_price::numeric AS sale_price,
        COALESCE(NULLIF(v.cost_price,0), 0)::numeric AS cost_price,
        COALESCE(bc.ean_code,'') AS ean_code,
        COALESCE(
          NULLIF(v.image_url, ''),
          CASE
            WHEN COALESCE(bc.ean_code,'') <> '' THEN CONCAT('https://res.cloudinary.com/', $${cloudIdx}, '/image/upload/f_auto,q_auto/products/', LOWER(p.gender), '/', bc.ean_code)
            ELSE NULL
          END,
          CASE
            WHEN p.gender = 'WOMEN' THEN '/images/women/women20.jpeg'
            WHEN p.gender = 'MEN'   THEN '/images/men/default.jpg'
            WHEN p.gender = 'KIDS'  THEN '/images/kids/default.jpg'
            ELSE '/images/placeholder.jpg'
          END
        ) AS image_url
      FROM products p
      JOIN product_variants v ON v.product_id = p.id
      LEFT JOIN LATERAL (
        SELECT ean_code FROM barcodes b WHERE b.variant_id = v.id ORDER BY id ASC LIMIT 1
      ) bc ON TRUE
      WHERE ${where}
      ORDER BY v.id DESC
    `;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/search', async (req, res) => {
  try {
    const query = req.query.q || req.query.query;
    if (!query || !String(query).trim()) {
      return res.status(400).json({ message: 'Search query is required' });
    }
    const term = `%${String(query).trim()}%`;
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';
    const { rows } = await pool.query(
      `SELECT
         v.id AS id,
         p.id AS product_id,
         p.name AS product_name,
         p.brand_name AS brand,
         p.gender AS gender,
         v.colour AS color,
         v.size AS size,
         v.mrp::numeric AS original_price_b2c,
         v.sale_price::numeric AS final_price_b2c,
         v.mrp::numeric AS original_price_b2b,
         COALESCE(NULLIF(v.cost_price,0), v.sale_price)::numeric AS final_price_b2b,
         v.mrp::numeric AS mrp,
         v.sale_price::numeric AS sale_price,
         COALESCE(NULLIF(v.cost_price,0), 0)::numeric AS cost_price,
         COALESCE(bc.ean_code,'') AS ean_code,
         COALESCE(
           NULLIF(v.image_url, ''),
           CASE
             WHEN COALESCE(bc.ean_code,'') <> '' THEN CONCAT('https://res.cloudinary.com/', $2, '/image/upload/f_auto,q_auto/products/', LOWER(p.gender), '/', bc.ean_code)
             ELSE NULL
           END,
           CASE
             WHEN p.gender = 'WOMEN' THEN '/images/women/women20.jpeg'
             WHEN p.gender = 'MEN'   THEN '/images/men/default.jpg'
             WHEN p.gender = 'KIDS'  THEN '/images/kids/default.jpg'
             ELSE '/images/placeholder.jpg'
           END
         ) AS image_url
       FROM products p
       JOIN product_variants v ON v.product_id = p.id
       LEFT JOIN LATERAL (
         SELECT ean_code FROM barcodes b WHERE b.variant_id = v.id ORDER BY id ASC LIMIT 1
       ) bc ON TRUE
       WHERE v.is_active = TRUE
         AND (
           p.name ILIKE $1
           OR p.brand_name ILIKE $1
           OR v.colour ILIKE $1
           OR p.gender ILIKE $1
         )
       ORDER BY v.id DESC`,
      [term, cloud]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Error searching products', error: err.message });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';
    const { rows } = await pool.query(
      `SELECT
         v.id AS id,
         p.id AS product_id,
         p.name AS product_name,
         p.brand_name AS brand,
         p.gender AS gender,
         v.colour AS color,
         v.size AS size,
         v.mrp::numeric AS original_price_b2c,
         v.sale_price::numeric AS final_price_b2c,
         v.mrp::numeric AS original_price_b2b,
         COALESCE(NULLIF(v.cost_price,0), v.sale_price)::numeric AS final_price_b2b,
         v.mrp::numeric AS mrp,
         v.sale_price::numeric AS sale_price,
         COALESCE(NULLIF(v.cost_price,0), 0)::numeric AS cost_price,
         COALESCE(bc.ean_code,'') AS ean_code,
         COALESCE(
           NULLIF(v.image_url, ''),
           CASE
             WHEN COALESCE(bc.ean_code,'') <> '' THEN CONCAT('https://res.cloudinary.com/', $2, '/image/upload/f_auto,q_auto/products/', LOWER(p.gender), '/', bc.ean_code)
             ELSE NULL
           END,
           CASE
             WHEN p.gender = 'WOMEN' THEN '/images/women/women20.jpeg'
             WHEN p.gender = 'MEN'   THEN '/images/men/default.jpg'
             WHEN p.gender = 'KIDS'  THEN '/images/kids/default.jpg'
             ELSE '/images/placeholder.jpg'
           END
         ) AS image_url
       FROM products p
       JOIN product_variants v ON v.product_id = p.id
       LEFT JOIN LATERAL (
         SELECT ean_code FROM barcodes b WHERE b.variant_id = v.id ORDER BY id ASC LIMIT 1
       ) bc ON TRUE
       WHERE v.id = $1`,
      [req.params.id, cloud]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
