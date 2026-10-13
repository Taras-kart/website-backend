const { test } = require('node:test')
const assert = require('node:assert/strict')
// Unit-level query checks; the full HTTP/DB test is in integration.test.js.
const dbPath = require.resolve('../db')
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query() {} } }
const { filters } = require('../utils/catalogue')
const { subtypeSql, slugs } = require('../utils/subtypes')

test('subtypes support the storefront labels and preserve SQL parameterization', () => {
  assert(slugs.includes('shimmer'))
  assert(slugs.includes('other'))
  assert(subtypeSql.includes("THEN 'shimmer'"))
  const { where, params } = filters({ brand: 'Twin Birds', categoryId: '6', subtype: 'shimmer' })
  assert(params.some(value => Array.isArray(value) && value[0] === 6))
  assert(params.some(value => Array.isArray(value) && value[0] === 'Twin Birds'))
  assert(params.includes('shimmer'))
  assert.match(where, /CASE WHEN/)
  assert.match(where, /END=\$4/)
})

test('invalid subtype cannot broaden product result scope', () => {
  const result = filters({ brand: 'Twin Birds', categoryId: '6', subtype: 'unknown-style' })
  assert(result.where.includes('FALSE'))
})
