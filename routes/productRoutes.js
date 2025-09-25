// D:\shopping-backend\routes\productRoutes.js
const express = require('express');
const pool = require('../db');
const router = express.Router();

const isMissing = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : NaN;
};

router.post('/', async (req, res) => {
  const {
    category,
    brand,
    product_name,
    color,
    size,
    original_price_b2b,
    discount_b2b,
    final_price_b2b,
    original_price_b2c,
    discount_b2c,
    final_price_b2c,
    total_count,
    image_url
  } = req.body;

  if (
    isMissing(category) ||
    isMissing(brand) ||
    isMissing(product_name) ||
    isMissing(color) ||
    isMissing(size) ||
    Number.isNaN(num(original_price_b2b)) ||
    Number.isNaN(num(discount_b2b)) ||
    Number.isNaN(num(final_price_b2b)) ||
    Number.isNaN(num(original_price_b2c)) ||
    Number.isNaN(num(discount_b2c)) ||
    Number.isNaN(num(final_price_b2c)) ||
    Number.isNaN(parseInt(total_count, 10)) ||
    isMissing(image_url)
  ) {
    return res.status(400).json({ message: 'Missing or invalid product fields' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO tarasproducts (
        category, brand, product_name, color, size,
        original_price_b2b, discount_b2b, final_price_b2b,
        original_price_b2c, discount_b2c, final_price_b2c,
        total_count, image_url
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [
        category.trim(),
        brand.trim(),
        product_name.trim(),
        color.trim(),
        size.trim(),
        num(original_price_b2b),
        num(discount_b2b),
        num(final_price_b2b),
        num(original_price_b2c),
        num(discount_b2c),
        num(final_price_b2c),
        Math.max(0, parseInt(total_count, 10)),
        image_url
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { category } = req.query;
    if (category) {
      const result = await pool.query('SELECT * FROM tarasproducts WHERE category = $1 ORDER BY id DESC', [category]);
      return res.json(result.rows);
    }
    const result = await pool.query('SELECT * FROM tarasproducts ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/category/:category', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tarasproducts WHERE category = $1 ORDER BY id DESC', [req.params.category]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/search', async (req, res) => {
  const query = req.query.q || req.query.query;
  if (!query || !String(query).trim()) {
    return res.status(400).json({ message: 'Search query is required' });
  }
  try {
    const searchTerm = `%${String(query).trim()}%`;
    const result = await pool.query(
      `SELECT * FROM tarasproducts
       WHERE TRIM(product_name) ILIKE $1
          OR TRIM(category) ILIKE $1
          OR TRIM(brand) ILIKE $1
          OR TRIM(color) ILIKE $1
       ORDER BY id DESC`,
      [searchTerm]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Error searching products', error: err.message });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM tarasproducts WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.put('/:id(\\d+)', async (req, res) => {
  const {
    category,
    brand,
    product_name,
    color,
    size,
    original_price_b2b,
    discount_b2b,
    final_price_b2b,
    original_price_b2c,
    discount_b2c,
    final_price_b2c,
    total_count,
    image_url
  } = req.body;

  if (
    isMissing(category) ||
    isMissing(brand) ||
    isMissing(product_name) ||
    isMissing(color) ||
    isMissing(size) ||
    Number.isNaN(num(original_price_b2b)) ||
    Number.isNaN(num(discount_b2b)) ||
    Number.isNaN(num(final_price_b2b)) ||
    Number.isNaN(num(original_price_b2c)) ||
    Number.isNaN(num(discount_b2c)) ||
    Number.isNaN(num(final_price_b2c)) ||
    Number.isNaN(parseInt(total_count, 10)) ||
    isMissing(image_url)
  ) {
    return res.status(400).json({ message: 'Missing or invalid product fields' });
  }

  try {
    const params = [
      category.trim(),
      brand.trim(),
      product_name.trim(),
      color.trim(),
      size.trim(),
      num(original_price_b2b),
      num(discount_b2b),
      num(final_price_b2b),
      num(original_price_b2c),
      num(discount_b2c),
      num(final_price_b2c),
      Math.max(0, parseInt(total_count, 10)),
      image_url,
      req.params.id
    ];

    const sql = `
      UPDATE tarasproducts
      SET category = $1,
          brand = $2,
          product_name = $3,
          color = $4,
          size = $5,
          original_price_b2b = $6,
          discount_b2b = $7,
          final_price_b2b = $8,
          original_price_b2c = $9,
          discount_b2c = $10,
          final_price_b2c = $11,
          total_count = $12,
          image_url = $13
      WHERE id = $14
      RETURNING *`;

    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM tarasproducts WHERE id = $1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Deleted', product: rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
