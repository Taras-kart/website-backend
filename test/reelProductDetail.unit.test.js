'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const registrations = new Map()
const router = {
  get: (route, handler) => registrations.set(route, handler)
}
let databaseRows
let calls
const pool = {
  async query(sql, params) {
    calls.push({ sql, params })
    if (sql.includes('style_key FROM product_variants')) return { rows: [{ style_key: 'style1' }] }
    if (sql.includes('ORDER BY v.colour,v.size,v.id')) return { rows: [{ id: 101 }, { id: 102 }] }
    if (sql.includes('FROM instagram_products i')) return { rows: databaseRows }
    throw Error('Unexpected database query: ' + sql)
  }
}
const hydrated = [
  { id: 101, product_name: 'Pink Cotton Nighty', size: 'M', color: 'Pink' },
  { id: 102, product_name: 'Pink Cotton Nighty', size: 'L', color: 'Pink' }
]
const targetPath = path.resolve(__dirname, '../routes/catalogueRoutes.js')
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (parent?.filename === targetPath) {
    if (request === 'express') return { Router: () => router }
    if (request === '../db') return pool
    if (request === '../utils/brands') return { brands: [], brandSql: () => '' }
    if (request === '../utils/catalogue') return {
      styleSql: 'style', sellingSql: () => '', availableSql: '', joins: 'JOIN product_variants v ON true',
      activeSql: 'active', categoryCte: 'WITH RECURSIVE', filters: () => ({ params: [], where: 'TRUE' }),
      hydrate: async () => hydrated, branchId: () => 4, hasImageSql: '', effectiveCategorySql: ''
    }
    if (request === '../utils/subtypes') return { subtypeSql: '', slugs: [] }
  }
  return originalLoad.call(this, request, parent, isMain)
}
try {
  require(targetPath)
} finally {
  Module._load = originalLoad
}

async function render(id, reelRows) {
  databaseRows = reelRows
  calls = []
  const handler = registrations.get('/:id(\\d+)/family')
  assert.equal(typeof handler, 'function')
  return await new Promise((resolve, reject) => {
    const res = {
      removeHeader() {},
      set() { return this },
      status(status) { this.code = status; return this },
      json(payload) { resolve({ payload, calls, status: this.code || 200 }); return this }
    }
    handler({ params: { id: String(id) } }, res, reject)
  })
}

test('published Reel code appears on the matching variant only', async () => {
  const result = await render(101, [
    { variant_id: 101, code: '00910012' },
    { variant_id: 102, code: 'REEL-910013' }
  ])
  assert.equal(result.status, 200)
  assert.equal(result.payload.product.instagram_code, '00910012')
  assert.equal(result.payload.variants[1].instagram_code, 'REEL-910013')
  const query = result.calls.find(call => call.sql.includes('FROM instagram_products i'))
  assert.match(query.sql, /i\.is_published\s*=\s*TRUE/)
  assert.match(query.sql, /b\.is_active\s*=\s*TRUE/)
  assert.match(query.sql, /i\.branch_id\s*=\s*\$2/)
  assert.deepEqual(query.params, [[101, 102], 4])
})

test('ordinary products do not get a fake Reel code', async () => {
  const result = await render(101, [])
  assert.equal(result.status, 200)
  assert.equal(result.payload.product.instagram_code, null)
  assert.equal(result.payload.variants[1].instagram_code, null)
})
