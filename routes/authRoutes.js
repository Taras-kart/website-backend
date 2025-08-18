const express = require('express');
const pool = require('../db');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const router = express.Router();

const ensureTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      email VARCHAR(255) PRIMARY KEY,
      otp_hash TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
};
ensureTable();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });
  try {
    const result = await pool.query('SELECT * FROM userstaras WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });
    const user = result.rows[0];
    const isMatch = password === user.password;
    if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });
    res.json({ id: user.id, name: user.name, email: user.email, type: user.type || 'customer' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:email', async (req, res) => {
  const { email } = req.params;
  try {
    const result = await pool.query('SELECT id, name, email, mobile, type, created_at FROM userstaras WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.post('/forgot/start', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });
  try {
    const result = await pool.query('SELECT id, type FROM userstaras WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'You are a new user. Please register' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query('DELETE FROM password_reset_tokens WHERE email = $1', [email]);
    await pool.query('INSERT INTO password_reset_tokens (email, otp_hash, expires_at) VALUES ($1, $2, $3)', [email, otpHash, expiresAt]);
    await transporter.sendMail({
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: email,
      subject: 'Your Tars Kart OTP',
      text: `Your OTP is ${otp}. It is valid for 10 minutes.`,
      html: `<div style="font-family:Arial,sans-serif;font-size:16px;color:#111">
        <p>Your OTP is <strong>${otp}</strong></p>
        <p>This code is valid for 10 minutes.</p>
      </div>`
    });
    res.json({ message: 'OTP sent' });
  } catch (err) {
    res.status(500).json({ message: 'Could not start reset' });
  }
});

router.post('/forgot/verify', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ message: 'Email and OTP are required' });
  try {
    const tok = await pool.query('SELECT otp_hash, expires_at FROM password_reset_tokens WHERE email = $1', [email]);
    if (tok.rows.length === 0) return res.status(400).json({ message: 'Invalid or expired OTP' });
    const row = tok.rows[0];
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ message: 'OTP expired' });
    const ok = await bcrypt.compare(otp, row.otp_hash);
    if (!ok) return res.status(400).json({ message: 'Invalid OTP' });
    res.json({ message: 'OTP verified' });
  } catch (err) {
    res.status(500).json({ message: 'Verification failed' });
  }
});

router.post('/forgot/reset', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) return res.status(400).json({ message: 'Email, OTP and new password are required' });
  try {
    const tok = await pool.query('SELECT otp_hash, expires_at FROM password_reset_tokens WHERE email = $1', [email]);
    if (tok.rows.length === 0) return res.status(400).json({ message: 'Invalid or expired OTP' });
    const row = tok.rows[0];
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ message: 'OTP expired' });
    const ok = await bcrypt.compare(otp, row.otp_hash);
    if (!ok) return res.status(400).json({ message: 'Invalid OTP' });
    await pool.query('UPDATE userstaras SET password = $1 WHERE email = $2', [newPassword, email]);
    await pool.query('DELETE FROM password_reset_tokens WHERE email = $1', [email]);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Password reset failed' });
  }
});

module.exports = router;
