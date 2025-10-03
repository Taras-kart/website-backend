const express = require('express');
const pool = require('../db');
const bcrypt = require('bcryptjs');
const { sign, requireAuth } = require('../middleware/auth');
const router = express.Router();

function isBcryptHash(s = '') {
  return typeof s === 'string' && (s.startsWith('$2a$') || s.startsWith('$2b$') || s.startsWith('$2y$'));
}

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ message: 'username and password required' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 AND is_active IS NOT FALSE', [username]);
    if (!rows.length) return res.status(401).json({ message: 'Invalid credentials' });
    const u = rows[0];
    let ok = false;
    if (isBcryptHash(u.hashed_pw)) {
      ok = await bcrypt.compare(password, u.hashed_pw);
    } else {
      ok = password === u.hashed_pw;
    }
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [u.id]);
    const token = sign(u);
    res.json({ token, user: { id: u.id, username: u.username, role: u.role_enum, branch_id: u.branch_id } });
  } catch (e) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, role_enum, branch_id, last_login FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!old_password || !new_password) return res.status(400).json({ message: 'Both passwords required' });
  try {
    const { rows } = await pool.query('SELECT hashed_pw FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ message: 'Not found' });
    let ok = false;
    const hp = rows[0].hashed_pw;
    if (isBcryptHash(hp)) {
      ok = await bcrypt.compare(old_password, hp);
    } else {
      ok = old_password === hp;
    }
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET hashed_pw = $1 WHERE id = $2', [hashed, req.user.id]);
    res.json({ message: 'Password updated' });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
