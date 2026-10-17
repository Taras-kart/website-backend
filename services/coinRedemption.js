const MAX_COINS_PER_UNIT = 10

function maxCoinRedemption(items) {
  if (!Array.isArray(items)) return 0
  return items.reduce((total, item) => {
    const quantity = Number(item.qty ?? item.quantity ?? 0)
    const price = Number(item.price ?? item.final_price_b2c ?? 0)
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 1) return total
    const paise = Math.round(price * 100)
    const coinsPerUnit = Math.max(0, Math.min(MAX_COINS_PER_UNIT, Math.floor((paise - 100) / 100)))
    return total + coinsPerUnit * quantity
  }, 0)
}

module.exports = { MAX_COINS_PER_UNIT, maxCoinRedemption }
