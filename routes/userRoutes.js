const express = require('express');
const pool = require('../db');
const router = express.Router();

// Get user details
router.get('/by-email/:email', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, mobile, type, created_at FROM userstaras WHERE email = $1',
      [req.params.email]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});


module.exports = router;
