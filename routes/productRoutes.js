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

function addHasImageWhere(whereSql) {
  return `
    (${whereSql})
    AND (
      (NULLIF(v.image_url,'') IS NOT NULL AND v.image_url NOT LIKE '/images/%')
      OR (NULLIF(pi.image_url,'') IS NOT NULL AND pi.image_url NOT LIKE '/images/%')
      OR COALESCE(bc_self.ean_code, bc_any.ean_code, '') <> ''
    )
  `;
}

async function fetchImageList({ gender, limit }) {
  const params = [];
  let where = 'v.is_active = TRUE';
  if (gender) {
    params.push(gender);
    where += ` AND p.gender = $${params.length}`;
  }
  where = addHasImageWhere(where);
  const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';
  params.push(cloud);
  const cloudIdx = params.length;
  params.push(limit);
  const limIdx = params.length;

  const sql = `
    WITH base AS (
      SELECT
        v.id AS id,
        p.id AS product_id,
        p.name AS product_name,
        p.brand_name AS brand,
        p.gender AS gender,
        v.colour AS color,
        v.size AS size,
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
      LEFT JOIN LATERAL (
        SELECT image_url
        FROM product_images pi
        WHERE pi.ean_code = COALESCE(bc_self.ean_code, bc_any.ean_code)
        ORDER BY uploaded_at DESC
        LIMIT 1
      ) pi ON TRUE
      WHERE ${where}
    )
    SELECT
      id,
      product_id,
      product_name,
      brand,
      gender,
      color,
      size,
      COALESCE(
        NULLIF(v_image,''),
        NULLIF(pi_image,''),
        CASE
          WHEN ean_code <> '' THEN CONCAT('https://res.cloudinary.com/', $${cloudIdx}::text, '/image/upload/f_auto,q_auto/products/', ean_code)
          ELSE NULL
        END
      ) AS image_url
    FROM base
    WHERE COALESCE(
      NULLIF(v_image,''),
      NULLIF(pi_image,''),
      CASE
        WHEN ean_code <> '' THEN CONCAT('https://res.cloudinary.com/', $${cloudIdx}::text, '/image/upload/f_auto,q_auto/products/', ean_code)
        ELSE NULL
      END
    ) IS NOT NULL
    ORDER BY RANDOM()
    LIMIT $${limIdx}
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

router.get('/', async (req, res) => {
  try {
    const genderQ = toGender(req.query.gender || req.query.category || '');
    const brand = req.query.brand ? String(req.query.brand).trim() : '';
    const q = req.query.q ? String(req.query.q).trim() : '';
    const rawLimit = parseInt(req.query.limit || '200', 10);
    const limit = Math.max(1, Math.min(50000, Number.isFinite(rawLimit) ? rawLimit : 200));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const wantRandom = String(req.query.random || '').trim() === '1';
    const wantHasImageOnly = String(req.query.hasImage || '').toLowerCase() === 'true';

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
    if (wantHasImageOnly) {
      where = addHasImageWhere(where);
    }

    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';
    params.push(cloud);
    const cloudIdx = params.length;

    params.push(limit, offset);
    const limIdx = params.length - 1;
    const offIdx = params.length;

    const orderBy = wantRandom ? 'ORDER BY RANDOM()' : 'ORDER BY v.id DESC';

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
        COALESCE(bc_self.ean_code, bc_any.ean_code, '') AS ean_code,
        COALESCE(
          NULLIF(v.image_url, ''),
          NULLIF(pi.image_url, ''),
          CASE
            WHEN COALESCE(bc_self.ean_code, bc_any.ean_code, '') <> '' THEN CONCAT('https://res.cloudinary.com/', $${cloudIdx}::text, '/image/upload/f_auto,q_auto/products/', COALESCE(bc_self.ean_code, bc_any.ean_code))
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
      LEFT JOIN LATERAL (
        SELECT image_url
        FROM product_images pi
        WHERE pi.ean_code = COALESCE(bc_self.ean_code, bc_any.ean_code)
        ORDER BY uploaded_at DESC
        LIMIT 1
      ) pi ON TRUE
      WHERE ${where}
      ${orderBy}
      LIMIT $${limIdx} OFFSET $${offIdx}
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
    const wantRandom = String(req.query.random || '').trim() === '1';
    const wantHasImageOnly = String(req.query.hasImage || '').toLowerCase() === 'true';
    const params = [];
    let where = 'v.is_active = TRUE';
    if (g) {
      params.push(g);
      where += ` AND p.gender = $${params.length}`;
    }
    if (wantHasImageOnly) {
      where = addHasImageWhere(where);
    }
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';
    params.push(cloud);
    const cloudIdx = params.length;

    const orderBy = wantRandom ? 'ORDER BY RANDOM()' : 'ORDER BY v.id DESC';

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
        COALESCE(bc_self.ean_code, bc_any.ean_code, '') AS ean_code,
        COALESCE(
          NULLIF(v.image_url, ''),
          NULLIF(pi.image_url, ''),
          CASE
            WHEN COALESCE(bc_self.ean_code, bc_any.ean_code, '') <> '' THEN CONCAT('https://res.cloudinary.com/', $${cloudIdx}::text, '/image/upload/f_auto,q_auto/products/', COALESCE(bc_self.ean_code, bc_any.ean_code))
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
      LEFT JOIN LATERAL (
        SELECT image_url
        FROM product_images pi
        WHERE pi.ean_code = COALESCE(bc_self.ean_code, bc_any.ean_code)
        ORDER BY uploaded_at DESC
        LIMIT 1
      ) pi ON TRUE
      WHERE ${where}
      ${orderBy}
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
    const wantRandom = String(req.query.random || '').trim() === '1';
    const wantHasImageOnly = String(req.query.hasImage || '').toLowerCase() === 'true';
    const params = [];
    let where = 'v.is_active = TRUE';
    if (g) {
      params.push(g);
      where += ` AND p.gender = $${params.length}`;
    }
    if (wantHasImageOnly) {
      where = addHasImageWhere(where);
    }
    const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'deymt9uyh';
    params.push(cloud);
    const cloudIdx = params.length;

    const orderBy = wantRandom ? 'ORDER BY RANDOM()' : 'ORDER BY v.id DESC';

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
        COALESCE(bc_self.ean_code, bc_any.ean_code, '') AS ean_code,
        COALESCE(
          NULLIF(v.image_url, ''),
          NULLIF(pi.image_url, ''),
          CASE
            WHEN COALESCE(bc_self.ean_code, bc_any.ean_code, '') <> '' THEN CONCAT('https://res.cloudinary.com/', $${cloudIdx}::text, '/image/upload/f_auto,q_auto/products/', COALESCE(bc_self.ean_code, bc_any.ean_code))
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
      LEFT JOIN LATERAL (
        SELECT image_url
        FROM product_images pi
        WHERE pi.ean_code = COALESCE(bc_self.ean_code, bc_any.ean_code)
        ORDER BY uploaded_at DESC
        LIMIT 1
      ) pi ON TRUE
      WHERE ${where}
      ${orderBy}
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
         COALESCE(bc_self.ean_code, bc_any.ean_code, '') AS ean_code,
         COALESCE(
           NULLIF(v.image_url, ''),
           NULLIF(pi.image_url, ''),
           CASE
             WHEN COALESCE(bc_self.ean_code, bc_any.ean_code, '') <> '' THEN CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', COALESCE(bc_self.ean_code, bc_any.ean_code))
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
       LEFT JOIN LATERAL (
         SELECT image_url
         FROM product_images pi
         WHERE pi.ean_code = COALESCE(bc_self.ean_code, bc_any.ean_code)
         ORDER BY uploaded_at DESC
         LIMIT 1
       ) pi ON TRUE
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

router.get('/hero-images', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(120, parseInt(req.query.limit || '60', 10)));
    const rows = await fetchImageList({ gender: null, limit });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/section-images', async (req, res) => {
  try {
    const limitHero = Math.max(1, Math.min(120, parseInt(req.query.limitHero || '30', 10)));
    const limitGender = Math.max(1, Math.min(80, parseInt(req.query.limitGender || '40', 10)));
    const hero = await fetchImageList({ gender: null, limit: limitHero });
    const women = await fetchImageList({ gender: 'WOMEN', limit: limitGender });
    const men = await fetchImageList({ gender: 'MEN', limit: limitGender });
    const kids = await fetchImageList({ gender: 'KIDS', limit: limitGender });
    res.json({ hero, women, men, kids });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
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
         COALESCE(bc_self.ean_code, bc_any.ean_code, '') AS ean_code,
         COALESCE(
           NULLIF(v.image_url, ''),
           NULLIF(pi.image_url, ''),
           CASE
             WHEN COALESCE(bc_self.ean_code, bc_any.ean_code, '') <> '' THEN CONCAT('https://res.cloudinary.com/', $2::text, '/image/upload/f_auto,q_auto/products/', COALESCE(bc_self.ean_code, bc_any.ean_code))
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
       LEFT JOIN LATERAL (
         SELECT image_url
         FROM product_images pi
         WHERE pi.ean_code = COALESCE(bc_self.ean_code, bc_any.ean_code)
         ORDER BY uploaded_at DESC
         LIMIT 1
       ) pi ON TRUE
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
