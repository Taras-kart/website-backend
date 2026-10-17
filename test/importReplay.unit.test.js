const { test } = require('node:test')
const assert = require('node:assert/strict')
const { checkReuploadSafety } = require('../services/importReplay')
const sample = [
  { ProductName: 'NIGHTY', BrandName: 'CHARAK', PATTERN: 'CH-ND-02', EANCode: '11559175', gender: 'WOMEN' },
  { ProductName: 'FEEDING NIGHTY', BrandName: 'CHARAK', PATTERN: 'CH-ND-02', EANCode: '11559274', gender: 'WOMEN' }
]
function stub({ assigned = false, active = false } = {}) {
  const calls = []
  return { calls, async query(sql, params) {
    calls.push({ sql, params })
    if (sql.includes('FROM barcodes')) return { rows: assigned ? [{ ean_code: '11559175' }] : [] }
    if (sql.includes('WITH incoming')) return { rows: active ? [{ id: 140 }] : [] }
    throw Error('Unexpected query')
  } }
}
test('completed file can be imported again only after all barcodes and styles are inactive', async () => {
  const db = stub()
  assert.deepEqual(await checkReuploadSafety(db, sample), { allowed: true })
  assert.deepEqual(db.calls[0].params[0], ['11559175', '11559274'])
  assert.equal(JSON.parse(db.calls[1].params[0]).length, 2)
})
test('a still-assigned barcode blocks duplicate inventory receipt', async () => {
  const check = await checkReuploadSafety(stub({ assigned: true }), sample)
  assert.equal(check.allowed, false)
  assert.match(check.reason, /barcode/i)
})
test('an active style blocks duplicate inventory receipt even if barcode is absent', async () => {
  const check = await checkReuploadSafety(stub({ active: true }), sample)
  assert.equal(check.allowed, false)
  assert.match(check.reason, /active product style/i)
})
test('a completed file with missing EAN cannot be replayed automatically', async () => {
  const check = await checkReuploadSafety(stub(), [{ ...sample[0], EANCode: '' }])
  assert.equal(check.allowed, false)
})
