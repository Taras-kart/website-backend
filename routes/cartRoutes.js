const express = require('express');
const pool = require('../db');
const router = express.Router();

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
    const result = await pool.query(
      `SELECT p.*, c.selected_size, c.selected_color
       FROM tarascart c
       JOIN tarasproducts p ON c.product_id = p.id
       WHERE c.user_id = $1`,
      [userId]
    );
    res.json(result.rows);
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
    await pool.query(
      `DELETE FROM tarascart WHERE user_id=$1 AND product_id=$2`,
      [user_id, product_id]
    );
    res.json({ message: 'Item removed from cart' });
  } catch (err) {
    res.status(500).json({ message: 'Error removing from cart', error: err.message });
  }
});

module.exports = router;
