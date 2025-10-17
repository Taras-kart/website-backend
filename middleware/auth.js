const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { sign } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ message: 'Missing credentials' });

    const { rows } = await pool.query(
      'SELECT id, username, hashed_pw, branch_id, role_enum FROM users WHERE username=$1 LIMIT 1',
      [username]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    let ok = false;
    const hash = user.hashed_pw || '';
    const looksHashed = /^\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash);

    if (looksHashed) {
      ok = await bcrypt.compare(password, hash);
    } else {
      ok = password === hash;
      if (ok) {
        const newHash = await bcrypt.hash(password, 10);
        await pool.query('UPDATE users SET hashed_pw=$1 WHERE id=$2', [newHash, user.id]);
      }
    }

    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    await pool.query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);
    const token = sign(user);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role_enum, branch_id: user.branch_id } });
  } catch (e) {
    console.error('auth-branch/login error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
