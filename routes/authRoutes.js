const express = require('express');
const pool = require('../db');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const router = express.Router();
require('dotenv').config();

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
    console.error(err);
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
    console.error(err);
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
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const updateResult = await pool.query('UPDATE userstaras SET otp = $1, otp_expiry = $2 WHERE email = $3', [otp, expiresAt, email]);

    if (updateResult.rowCount === 0) {
      return res.status(500).json({ message: 'Failed to update OTP' });
    }

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
    console.error(err);
    res.status(500).json({ message: 'Could not start reset' });
  }
});

router.post('/forgot/verify', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ message: 'Email and OTP are required' });

  try {
    const result = await pool.query('SELECT otp, otp_expiry FROM userstaras WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ message: 'Invalid or expired OTP' });

    const user = result.rows[0];
    if (user.otp !== otp) return res.status(400).json({ message: 'Invalid OTP' });
    if (new Date(user.otp_expiry).getTime() < Date.now()) return res.status(400).json({ message: 'OTP expired' });

    res.json({ message: 'OTP verified' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Verification failed' });
  }
});

router.post('/forgot/reset', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) return res.status(400).json({ message: 'Email, OTP, and new password are required' });

  try {
    const result = await pool.query('SELECT otp, otp_expiry FROM userstaras WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ message: 'Invalid or expired OTP' });

    const user = result.rows[0];
    if (user.otp !== otp) return res.status(400).json({ message: 'Invalid OTP' });
    if (new Date(user.otp_expiry).getTime() < Date.now()) return res.status(400).json({ message: 'OTP expired' });

    await pool.query('UPDATE userstaras SET password = $1 WHERE email = $2', [newPassword, email]);

    await pool.query('UPDATE userstaras SET otp = NULL, otp_expiry = NULL WHERE email = $1', [email]);

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Password reset failed' });
  }
});


module.exports = router;
