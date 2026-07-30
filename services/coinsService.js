// services/coinsService.js
// Core coins business logic for Attach coin wallet

const pool = require('../db')

// ─── Settings helpers ────────────────────────────────────────────────────────

async function getSetting(key) {
  const { rows } = await pool.query(
    'SELECT value FROM coin_settings WHERE key=$1',
    [key]
  )
  return rows[0]?.value ?? null
}

async function getAllSettings() {
  const { rows } = await pool.query('SELECT key, value FROM coin_settings')
  const out = {}
  for (const r of rows) out[r.key] = r.value
  return out
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO coin_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  )
}

async function isEnabled() {
  const val = await getSetting('coins_enabled')
  return val === 'true'
}

// ─── Wallet helpers ──────────────────────────────────────────────────────────

/**
 * Get wallet for a user. Returns null if no wallet exists yet.
 */
async function getWallet(userId, client) {
  const db = client || pool
  const { rows } = await db.query(
    'SELECT * FROM coin_wallets WHERE user_id=$1',
    [userId]
  )
  return rows[0] || null
}

/**
 * Ensure wallet exists for user. Creates with zero balance if missing.
 */
async function ensureWallet(userId, client) {
  const db = client || pool
  await db.query(
    `INSERT INTO coin_wallets (user_id, balance, signup_coins_remaining, paid_orders_count)
     VALUES ($1, 0, 0, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  )
  return getWallet(userId, db)
}

/**
 * Record a coin transaction and update wallet balance atomically.
 * type: SIGNUP_BONUS | EARNED | REDEEMED | CLAWBACK | RELEASED | DISCARDED
 * amount: positive = credit, negative = debit
 */
async function recordTransaction(client, { userId, amount, type, saleId = null, note = null }) {
  // Update wallet balance
  await client.query(
    `UPDATE coin_wallets
     SET balance = balance + $2, updated_at = now()
     WHERE user_id = $1`,
    [userId, amount]
  )
  // Insert transaction record
  await client.query(
    `INSERT INTO coin_transactions (user_id, amount, type, sale_id, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, amount, type, saleId || null, note || null]
  )
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Credit signup bonus to a new user.
 * Called when account is created (email or Google).
 * Safe to call multiple times — checks if wallet already exists.
 */
async function creditSignupBonus(userId) {
  if (!(await isEnabled())) return
  const bonusStr = await getSetting('coins_signup_bonus')
  const bonus = parseInt(bonusStr || '100', 10)
  if (!bonus) return

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Check if wallet already exists (prevent double credit)
    const existing = await getWallet(userId, client)
    if (existing) {
      await client.query('ROLLBACK')
      return
    }

    // Create wallet with signup bonus
    await client.query(
      `INSERT INTO coin_wallets (user_id, balance, signup_coins_remaining, paid_orders_count)
       VALUES ($1, $2, $2, 0)`,
      [userId, bonus]
    )
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, note)
       VALUES ($1, $2, 'SIGNUP_BONUS', 'Welcome bonus coins')`,
      [userId, bonus]
    )

    await client.query('COMMIT')
    console.log(`Coins: credited ${bonus} signup bonus to user ${userId}`)
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('Coins: creditSignupBonus failed:', e.message)
  } finally {
    client.release()
  }
}

/**
 * Validate and reserve coins for an order at checkout.
 * Returns { ok, coinsApplied, discount } or { ok: false, message }
 */
async function reserveCoins(userId, requestedCoins, orderSubtotal, isB2B = false) {
  if (!(await isEnabled())) return { ok: false, message: 'Coins are disabled' }
  if (requestedCoins <= 0) return { ok: false, message: 'Invalid coin amount' }

  // Check B2B setting
  if (isB2B) {
    const b2bEnabled = await getSetting('coins_b2b_enabled')
    if (b2bEnabled !== 'true') return { ok: false, message: 'Coins not available for B2B orders' }
  }

  const wallet = await getWallet(userId)
  if (!wallet) return { ok: false, message: 'Coin wallet not found' }
  if (wallet.balance <= 0) return { ok: false, message: 'Insufficient coin balance' }

  // Cap coins to available balance
  const available = wallet.balance
  const coinsToUse = Math.min(requestedCoins, available)

  // Cap coins to 10% of order subtotal (max discount per order)
  const maxAllowed = Math.floor(orderSubtotal * 0.10)
  const finalCoins = Math.min(coinsToUse, maxAllowed)
  if (finalCoins <= 0) return { ok: false, message: `Coins usable up to 10% of order value (max ₹${maxAllowed})` }

  // Check redeem order limit — signup bonus only usable in first N orders
  const limitStr = await getSetting('coins_redeem_order_limit')
  const limit = parseInt(limitStr || '5', 10)
  const paidOrdersCount = wallet.paid_orders_count || 0
  const signupCoinsRemaining = wallet.signup_coins_remaining || 0

  // If user is beyond the limit and only has signup coins, block
  if (paidOrdersCount >= limit && wallet.balance <= 0) {
    return { ok: false, message: 'No redeemable coins available' }
  }

  return {
    ok: true,
    coinsApplied: finalCoins,
    discount: finalCoins, // 1 coin = ₹1
    maxAllowed
  }
}

/**
 * Deduct coins when order is placed.
 * Uses signup coins first, then earned coins.
 * Called inside the order placement transaction.
 */
async function deductCoinsForOrder(client, { userId, coinsToDeduct, saleId }) {
  const wallet = await getWallet(userId, client)
  if (!wallet) throw new Error('Wallet not found')
  if (wallet.balance < coinsToDeduct) throw new Error('Insufficient coins')

  // Deduct from signup_coins_remaining first
  const signupDeduction = Math.min(coinsToDeduct, wallet.signup_coins_remaining)
  const earnedDeduction = coinsToDeduct - signupDeduction

  // Update wallet
  await client.query(
    `UPDATE coin_wallets
     SET balance = balance - $2,
         signup_coins_remaining = signup_coins_remaining - $3,
         updated_at = now()
     WHERE user_id = $1`,
    [userId, coinsToDeduct, signupDeduction]
  )

  await client.query(
    `INSERT INTO coin_transactions (user_id, amount, type, sale_id, note)
     VALUES ($1, $2, 'REDEEMED', $3, $4)`,
    [userId, -coinsToDeduct, saleId,
     `Redeemed: ${signupDeduction} signup + ${earnedDeduction} earned`]
  )
}

/**
 * Release (refund) coins back to wallet when payment fails.
 * Called in Razorpay failed handler.
 */
async function releaseCoinsOnFailure(userId, saleId) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Find the REDEEMED transaction for this sale
    const tx = await client.query(
      `SELECT amount FROM coin_transactions
       WHERE user_id=$1 AND sale_id=$2 AND type='REDEEMED'
       LIMIT 1`,
      [userId, saleId]
    )
    if (!tx.rowCount) {
      await client.query('ROLLBACK')
      return // No coins were used
    }

    const deducted = Math.abs(tx.rows[0].amount)

    // Find how much was signup vs earned from the note
    const noteMatch = tx.rows[0].note?.match(/(\d+) signup \+ (\d+) earned/)
    const signupRefund = noteMatch ? parseInt(noteMatch[1], 10) : 0

    await client.query(
      `UPDATE coin_wallets
       SET balance = balance + $2,
           signup_coins_remaining = signup_coins_remaining + $3,
           updated_at = now()
       WHERE user_id = $1`,
      [userId, deducted, signupRefund]
    )

    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, sale_id, note)
       VALUES ($1, $2, 'RELEASED', $3, 'Coins returned due to payment failure')`,
      [userId, deducted, saleId]
    )

    await client.query('COMMIT')
    console.log(`Coins: released ${deducted} coins back to user ${userId} for failed sale ${saleId}`)
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('Coins: releaseCoinsOnFailure failed:', e.message)
  } finally {
    client.release()
  }
}

/**
 * Credit earned coins after successful delivery + payment.
 * Called from Shiprocket webhook on DELIVERED status.
 * Also: increments paid_orders_count and discards signup bonus if limit reached.
 */
async function creditEarnedCoins(userId, saleId, orderSubtotal) {
  if (!(await isEnabled())) return

  const earnRateStr = await getSetting('coins_earn_rate_pct')
  const earnRate = parseFloat(earnRateStr || '10')
  const coinsEarned = Math.floor((orderSubtotal * earnRate) / 100)

  const limitStr = await getSetting('coins_redeem_order_limit')
  const limit = parseInt(limitStr || '5', 10)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    await ensureWallet(userId, client)

    // Check if already credited for this sale (idempotency)
    const existing = await client.query(
      `SELECT id FROM coin_transactions
       WHERE user_id=$1 AND sale_id=$2 AND type='EARNED'`,
      [userId, saleId]
    )
    if (existing.rowCount) {
      await client.query('ROLLBACK')
      return // Already credited
    }

    // Increment paid orders count
    await client.query(
      `UPDATE coin_wallets
       SET paid_orders_count = paid_orders_count + 1,
           updated_at = now()
       WHERE user_id = $1`,
      [userId]
    )

    // Credit earned coins
    if (coinsEarned > 0) {
      await client.query(
        `UPDATE coin_wallets
         SET balance = balance + $2, updated_at = now()
         WHERE user_id = $1`,
        [userId, coinsEarned]
      )
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, sale_id, note)
         VALUES ($1, $2, 'EARNED', $3, $4)`,
        [userId, coinsEarned, saleId,
         `Earned from order (${earnRate}% of ₹${orderSubtotal})`]
      )
    }

    // Check if this is the Nth paid order — discard remaining signup coins
    const wallet = await getWallet(userId, client)
    if (wallet.paid_orders_count >= limit && wallet.signup_coins_remaining > 0) {
      const toDiscard = wallet.signup_coins_remaining
      await client.query(
        `UPDATE coin_wallets
         SET balance = balance - $2,
             signup_coins_remaining = 0,
             updated_at = now()
         WHERE user_id = $1`,
        [userId, toDiscard]
      )
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, sale_id, note)
         VALUES ($1, $2, 'DISCARDED', $3, 'Signup bonus expired after 5 paid orders')`,
        [userId, -toDiscard, saleId]
      )
      console.log(`Coins: discarded ${toDiscard} signup coins for user ${userId}`)
    }

    await client.query('COMMIT')
    console.log(`Coins: credited ${coinsEarned} earned coins to user ${userId}`)
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('Coins: creditEarnedCoins failed:', e.message)
  } finally {
    client.release()
  }
}

/**
 * Clawback earned coins when a return is approved.
 * Can go negative.
 */
async function clawbackCoins(userId, saleId) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Find the EARNED transaction for this sale
    const tx = await client.query(
      `SELECT amount FROM coin_transactions
       WHERE user_id=$1 AND sale_id=$2 AND type='EARNED'
       LIMIT 1`,
      [userId, saleId]
    )
    if (!tx.rowCount) {
      await client.query('ROLLBACK')
      return // No earned coins to clawback
    }

    const earned = tx.rows[0].amount

    // Check not already clawed back
    const already = await client.query(
      `SELECT id FROM coin_transactions
       WHERE user_id=$1 AND sale_id=$2 AND type='CLAWBACK'`,
      [userId, saleId]
    )
    if (already.rowCount) {
      await client.query('ROLLBACK')
      return
    }

    await client.query(
      `UPDATE coin_wallets
       SET balance = balance - $2, updated_at = now()
       WHERE user_id = $1`,
      [userId, earned]
    )
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, sale_id, note)
       VALUES ($1, $2, 'CLAWBACK', $3, 'Coins clawed back due to return approval')`,
      [userId, -earned, saleId]
    )

    await client.query('COMMIT')
    console.log(`Coins: clawed back ${earned} coins from user ${userId} for returned sale ${saleId}`)
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('Coins: clawbackCoins failed:', e.message)
  } finally {
    client.release()
  }
}

module.exports = {
  getSetting,
  getAllSettings,
  setSetting,
  getWallet,
  ensureWallet,
  deductCoinsForOrder,
  creditSignupBonus,
  reserveCoins,
  releaseCoinsOnFailure,
  creditEarnedCoins,
  clawbackCoins
}
