const express = require('express');
const pool = require('../db');
const router = express.Router();

router.get('/shipments/by-sale/:id', async (req, res) => {
  const id = req.params.id;
  const { rows } = await pool.query(
    'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC',
    [id]
  );
  res.json(rows);
});

module.exports = router;
