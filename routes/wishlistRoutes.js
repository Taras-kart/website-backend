const express = require('express');
const pool = require('../db');
const router = express.Router();

// Add to wishlist
router.post('/', async (req, res) => {
  const { user_id, product_id } = req.body;
  if (!user_id || !product_id) {
    return res.status(400).json({ message: 'User ID and Product ID are required' });
  }

  try {
    await pool.query(
      'INSERT INTO taraswishlist (user_id, product_id) VALUES ($1, $2)', // Changed table name here
      [user_id, product_id]
    );
    res.json({ message: 'Added to wishlist' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Get wishlist
  router.get('/:user_id', async (req, res) => {
  const userId = req.params.user_id; 
  try {
    const result = await pool.query(
      `SELECT p.* FROM taraswishlist w
       JOIN tarasproducts p ON w.product_id = p.id
       WHERE w.user_id = $1`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching wishlist', error: err.message });
  }
});

// Delete from wishlist
router.delete('/', async (req, res) => {
  const { user_id, product_id } = req.body;
  if (!user_id || !product_id) {
    return res.status(400).json({ message: 'User ID and Product ID are required' });
  }

  try {
    await pool.query(
      'DELETE FROM taraswishlist WHERE user_id = $1 AND product_id = $2',
      [user_id, product_id]
    );
    res.json({ message: 'Removed from wishlist' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});




module.exports = router;
