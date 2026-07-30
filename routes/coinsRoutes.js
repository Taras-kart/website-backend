// routes/coinsRoutes.js
const express = require('express')
const { requireAuth } = require('../middleware/auth')
const {
  getWallet,
  ensureWallet,
  reserveCoins,
  getAllSettings,
  setSetting
} = require('../services/coinsService')

const router = express.Router()

// ─── Customer routes ─────────────────────────────────────────────────────────

/**
 * GET /api/coins/wallet
 * Returns the current user's coin wallet balance.
 * Frontend uses this for profile page and checkout display.
 * Requires: Firebase JWT token with user email in payload.
 */
router.get('/wallet', async (req, res) => {
  try {
    const userEmail = String(req.query.email || '').trim()
    if (!userEmail) return res.status(400).json({ ok: false, message: 'email required' })

    // Look up user by email
    const pool = require('../db')
    const userRow = await pool.query(
      'SELECT id FROM userstaras WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [userEmail]
    )
    if (!userRow.rowCount) {
      return res.json({ ok: true, balance: 0, signup_coins_remaining: 0, paid_orders_count: 0 })
    }

    const userId = userRow.rows[0].id
    let wallet = await getWallet(userId)
    if (!wallet) {
      wallet = { balance: 0, signup_coins_remaining: 0, paid_orders_count: 0 }
    }

    return res.json({
      ok: true,
      balance: wallet.balance,
      signup_coins_remaining: wallet.signup_coins_remaining,
      paid_orders_count: wallet.paid_orders_count
    })
  } catch (e) {
    console.error('GET /coins/wallet error:', e.message)
    return res.status(500).json({ ok: false, message: 'Server error' })
  }
})

/**
 * POST /api/coins/validate
 * Validates how many coins can be applied to an order.
 * Called when user clicks "Apply" on checkout page.
 * Body: { email, coins_requested, order_subtotal, is_b2b? }
 */
router.post('/validate', async (req, res) => {
  try {
    const { email, coins_requested, order_subtotal, is_b2b } = req.body || {}
    if (!email || !coins_requested || !order_subtotal) {
      return res.status(400).json({ ok: false, message: 'email, coins_requested, order_subtotal required' })
    }

    const pool = require('../db')
    const userRow = await pool.query(
      'SELECT id FROM userstaras WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email]
    )
    if (!userRow.rowCount) {
      return res.status(404).json({ ok: false, message: 'User not found' })
    }

    const userId = userRow.rows[0].id
    const result = await reserveCoins(
      userId,
      Number(coins_requested),
      Number(order_subtotal),
      Boolean(is_b2b)
    )

    return res.json(result)
  } catch (e) {
    console.error('POST /coins/validate error:', e.message)
    return res.status(500).json({ ok: false, message: 'Server error' })
  }
})

// ─── Super admin routes ───────────────────────────────────────────────────────

function requireSuperAdmin(req, res, next) {
  const role = String(req.user?.role || req.user?.role_enum || '').toUpperCase()
  if (role !== 'SUPER_ADMIN') return res.status(403).json({ ok: false, message: 'Forbidden' })
  next()
}

/**
 * GET /api/coins/settings
 * Returns all coins settings for the super admin page.
 */
router.get('/settings', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const settings = await getAllSettings()
    return res.json({ ok: true, settings })
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Server error' })
  }
})

/**
 * POST /api/coins/settings
 * Update one or more coins settings.
 * Body: { coins_enabled?, coins_signup_bonus?, coins_earn_rate_pct?, coins_redeem_order_limit?, coins_b2b_enabled? }
 */
router.post('/settings', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const allowed = [
      'coins_enabled',
      'coins_signup_bonus',
      'coins_earn_rate_pct',
      'coins_redeem_order_limit',
      'coins_b2b_enabled'
    ]
    const updates = []
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        await setSetting(key, req.body[key])
        updates.push(key)
      }
    }
    if (!updates.length) {
      return res.status(400).json({ ok: false, message: 'No valid settings provided' })
    }
    const settings = await getAllSettings()
    return res.json({ ok: true, updated: updates, settings })
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Server error' })
  }
})

module.exports = router
