// Keep the style taxonomy consistent between the subcategory directory and catalogue filtering.
// Subcategories created in the admin are managed separately through product_categories.
const styleText = "LOWER(CONCAT_WS(' ', p.name, COALESCE(p.fit_type, ''), COALESCE(v.fit, ''), COALESCE(p.pattern_code, '')))"

// Specific phrases precede their broader equivalents (non-wired before wired, etc.).
const rules = [
  ['non-padded', ['non-padded', 'non padded']],
  ['non-wired', ['non-wired', 'non wired']],
  ['push-up', ['push-up', 'push up']],
  ['t-shirt', ['t-shirt', 't shirt']],
  ['shimmer', ['shimmer']],
  ['viscose', ['viscose']],
  ['cotton', ['cotton']],
  ['lycra', ['lycra']],
  ['rayon', ['rayon']],
  ['nylon', ['nylon']],
  ['polyester', ['polyester']],
  ['spandex', ['spandex']],
  ['silk', ['silk']],
  ['modal', ['modal']],
  ['seamless', ['seamless']],
  ['ribbed', ['ribbed', 'rib']],
  ['denim', ['denim']],
  ['fleece', ['fleece']],
  ['thermal', ['thermal']],
  ['printed', ['printed', 'print']],
  ['sports', ['sports', 'sport']],
  ['padded', ['padded']],
  ['wired', ['wired']],
  ['maternity', ['maternity']]
]
const slugs = [...rules.map(([slug]) => slug), 'other']
const escapeSql = value => value.replaceAll("'", "''")
const subtypeSql = `CASE ${rules.map(([slug, terms]) =>
  `WHEN (${terms.map(term => `${styleText} LIKE '%${escapeSql(term)}%'`).join(' OR ')}) THEN '${slug}'`
).join(' ')} ELSE 'other' END`

module.exports = { subtypeSql, slugs }
