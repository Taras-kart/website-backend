const canonical = value => String(value ?? '').trim().toLowerCase()
async function checkReuploadSafety(db, rows) {
  if (!rows.length || rows.some(row => !String(row.EANCode || '').trim())) {
    return { allowed: false, reason: 'This Excel was previously imported. To reupload a deleted file, every row must have a barcode.' }
  }
  const eans = [...new Set(rows.map(row => String(row.EANCode).trim()))]
  const barcodeInUse = await db.query('SELECT ean_code FROM barcodes WHERE ean_code = ANY($1::text[]) LIMIT 1', [eans])
  if (barcodeInUse.rows.length) {
    return { allowed: false, reason: `A barcode from this previously imported file is still assigned (${barcodeInUse.rows[0].ean_code}). Delete all matching products before uploading the entire Excel again, or upload only the missing products.` }
  }
  const styles = [...new Map(rows.map(row => {
    const value = { name: canonical(row.ProductName), brand: canonical(row.BrandName), pattern: canonical(row.PATTERN), gender: canonical(row.gender) }
    return [JSON.stringify(value), value]
  })).values()]
  const current = await db.query(`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb)
      AS x(name text, brand text, pattern text, gender text)
    )
    SELECT p.id FROM products p
    JOIN incoming x ON lower(btrim(p.name))=x.name
      AND lower(btrim(p.brand_name))=x.brand
      AND lower(btrim(COALESCE(p.pattern_code,'')))=x.pattern
      AND lower(btrim(p.gender::text))=x.gender
    WHERE EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.is_active=TRUE)
    LIMIT 1
  `, [JSON.stringify(styles)])
  if (current.rows.length) {
    return { allowed: false, reason: 'An active product style from this previously imported file still exists. Reuploading the entire file would duplicate stock. Delete every matching variant first, or upload only the missing rows.' }
  }
  return { allowed: true }
}
module.exports = { checkReuploadSafety }
