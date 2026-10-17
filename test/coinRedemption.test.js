const { test } = require('node:test')
const assert = require('node:assert/strict')
const { maxCoinRedemption, MAX_COINS_PER_UNIT } = require('../services/coinRedemption')

test('each full-price unit permits at most ten coins', () => {
  assert.equal(MAX_COINS_PER_UNIT, 10)
  assert.equal(maxCoinRedemption([{ price: 499, qty: 1 }]), 10)
  assert.equal(maxCoinRedemption([{ price: 499, qty: 3 }]), 30)
  assert.equal(maxCoinRedemption([{ price: 499, qty: 2 }, { price: 549, qty: 1 }]), 30)
})

test('low-price items always retain at least one rupee per unit', () => {
  assert.equal(maxCoinRedemption([{ price: 1, qty: 1 }]), 0)
  assert.equal(maxCoinRedemption([{ price: 5, qty: 1 }]), 4)
  assert.equal(maxCoinRedemption([{ price: 10, qty: 2 }]), 18)
  assert.equal(maxCoinRedemption([{ price: 11, qty: 2 }]), 20)
  assert.equal(maxCoinRedemption([{ price: 9.99, qty: 1 }]), 8)
})

test('incorrect or missing values cannot expand redemption', () => {
  assert.equal(maxCoinRedemption([]), 0)
  assert.equal(maxCoinRedemption([{ price: 500, qty: -1 }]), 0)
  assert.equal(maxCoinRedemption([{ price: 500, qty: 1.5 }]), 0)
  assert.equal(maxCoinRedemption([{ price: 'invalid', qty: 2 }]), 0)
})
