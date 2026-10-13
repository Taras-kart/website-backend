// Product-derived subcategories are used for leaf categories that do not have
// actual child rows in product_categories. Keep these patterns consistent with
// the catalogue filter so that a tile never opens a mixed product listing.
const definitions = [
  ['shimmer', 'Shimmer', /\bshimmer(?:s|ing)?\b/i],
  ['viscose', 'Viscose', /\bviscose\b/i],
  ['cotton', 'Cotton', /\bcotton\b/i],
  ['lycra', 'Lycra', /\blycra\b/i],
  ['rayon', 'Rayon', /\brayon\b/i],
  ['nylon', 'Nylon', /\bnylon\b/i],
  ['polyester', 'Polyester', /\bpolyester\b/i],
  ['spandex', 'Spandex', /\bspandex\b/i],
  ['silk', 'Silk', /\bsilk\b/i],
  ['modal', 'Modal', /\bmodal\b/i],
  ['seamless', 'Seamless', /\bseamless\b/i],
  ['ribbed', 'Ribbed', /\bribb?ed\b/i],
  ['denim', 'Denim', /\bdenim\b/i],
  ['fleece', 'Fleece', /\bfleece\b/i],
  ['thermal', 'Thermal', /\bthermal\b/i],
  ['printed', 'Printed', /\bprint(?:ed)?\b/i],
  ['sports', 'Sports', /\bsports?\b/i],
  ['non-padded', 'Non-padded', /\b(?:non[ -]?padded|unpadded)\b/i],
  ['padded', 'Padded', /\bpadded\b/i],
  ['non-wired', 'Non-wired', /\b(?:non[ -]?wired|wirefree|wire-free)\b/i],
  ['wired', 'Wired', /\bwired\b/i],
  ['push-up', 'Push-up', /\bpush[ -]?up\b/i],
  ['t-shirt', 'T-shirt', /\bt[ -]?shirt\b/i],
  ['maternity', 'Maternity', /\bmaternity\b/i]
].map(([slug,label,expression])=>({slug,label,expression}))

const mutuallyExclusive = { padded: 'non-padded', wired: 'non-wired' }
const terms = record => [record?.name,record?.pattern_code,record?.fit_type,record?.fit].filter(Boolean).join(' ')
const matches = (record,slug) => {
  const term = terms(record)
  if (slug === 'other') return !definitions.some(item => item.expression.test(term))
  const item = definitions.find(item => item.slug === slug)
  const excluded = definitions.find(entry => entry.slug === mutuallyExclusive[slug])
  return Boolean(item && item.expression.test(term) && !(excluded && excluded.expression.test(term)))
}
const sqlText = `concat_ws(' ',p.name,p.pattern_code,p.fit_type,v.fit)`
const regexSql = expression => {
  let opening = true
  return expression.source.replace(/\\b/g, () => {
    const boundary = opening ? '\\m' : '\\M'
    opening = !opening
    return boundary
  }).replace(/\(\?:/g,'(')
}
// Use the same user-facing slugs as the facet classifier; patterns are fixed,
// never compiled from user supplied regex text.
function sqlFilter(slug) {
  if (slug === 'other') return `NOT (${definitions.map(item=>`${sqlText} ~* '${regexSql(item.expression).replace(/'/g,"''")}'`).join(' OR ')})`
  const item = definitions.find(item=>item.slug===slug)
  if (!item) return 'FALSE'
  const expression = `${sqlText} ~* '${regexSql(item.expression).replace(/'/g,"''")}'`
  const excluded = definitions.find(entry => entry.slug === mutuallyExclusive[slug])
  return excluded ? `(${expression} AND NOT (${sqlText} ~* '${regexSql(excluded.expression).replace(/'/g,"''")}'))` : expression
}
module.exports = { definitions, matches, sqlFilter }
