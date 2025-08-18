const express = require('express');
const pool = require('../db');
const router = express.Router();

// Add product
router.post('/', async (req, res) => {
  const {
    category, brand, product_name, color, size,
    original_price_b2b, discount_b2b, final_price_b2b,
    original_price_b2c, discount_b2c, final_price_b2c,
    total_count, image_url
  } = req.body;

  if (!category || !brand || !product_name || !color || !size ||
      !original_price_b2b || !discount_b2b || !final_price_b2b ||
      !original_price_b2c || !discount_b2c || !final_price_b2c ||
      !total_count || !image_url) {
    return res.status(400).json({ message: 'Missing required product fields' });
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
        category, brand, product_name, color, size,
        original_price_b2b, discount_b2b, final_price_b2b,
        original_price_b2c, discount_b2c, final_price_b2c,
        total_count, image_url
      ]
    );
    res.status(201).json({ message: 'Product added successfully', product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Get all products
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tarasproducts');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Search products
router.get('/search', async (req, res) => {
  const query = req.query.q || req.query.query;
  if (!query) {
    return res.status(400).json({ message: 'Search query is required' });
  }

  try {
    const searchTerm = `%${query.trim()}%`;
    const result = await pool.query(
      `SELECT * FROM tarasproducts
       WHERE TRIM(product_name) ILIKE $1
       OR TRIM(category) ILIKE $1
       OR TRIM(brand) ILIKE $1
       OR TRIM(color) ILIKE $1`,
      [searchTerm]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Error searching products', error: err.message });
  }
});

// Get products by category
router.get('/:category', async (req, res) => {
  const { category } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM tarasproducts WHERE category = $1',
      [category]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
