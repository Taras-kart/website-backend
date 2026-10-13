// routes/b2bImportRoutes.js
// Handles B2B product Excel import
// POST /api/b2b/import  — upload Excel, parse, insert into b2b_products

const express = require('express')
const multer = require('multer')
const XLSX = require('xlsx')
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
})

// ── Column aliases for B2B Excel ─────────────────────────────────────────────
const B2B_ALIASES = {
  brandname:    ['brand name', 'brand', 'brandname'],
  productname:  ['product', 'product name', 'item', 'productname'],
  stylecode:    ['eancode/style', 'ean code/style', 'style', 'style code', 'ean', 'eancode', 'style_code'],
  mrp:          ['mrp'],
  markdownpct:  ['b to b mark down', 'b2b mark down', 'b2b markdown', 'mark down', 'markdown', 'b to b markdown'],
  masterbox:    ['b to b master box', 'b2b master box', 'master box', 'masterbox'],
  purchaseqty:  ['b to b purchase qty', 'b2b purchase qty', 'purchase qty', 'b to b purchase quantity'],
  avbqty:       ['avb quantity pcs', 'avb qty', 'available qty', 'available quantity'],
  avbsizes:     ['avb sizes', 'available sizes', 'sizes'],
  colour:       ['colour', 'color'],
  pattern:      ['design pattern', 'pattern', 'design'],
  fit:          ['fit', 'fit type'],
}

function normalizeB2BRow(raw) {
  const out = {}
  // Lowercase all keys
  for (const [k, v] of Object.entries(raw || {})) {
    out[String(k).trim().toLowerCase()] = v
  }
  // Resolve aliases
  for (const [canon, aliases] of Object.entries(B2B_ALIASES)) {
    if (out[canon] != null && out[canon] !== '') continue
    for (const alias of aliases) {
      const a = alias.trim().toLowerCase()
      if (out[a] != null && out[a] !== '') {
        out[canon] = out[a]
        break
      }
    }
  }
  return out
}

function cleanText(v) {
  if (v == null) return ''
  return String(v).replace(/\s+/g, ' ').trim()
}

function toNumOrNull(v) {
  if (v == null || v === '' || String(v).trim() === '') return null
  // Handle percentage strings like "-42%" or "-42"
  const s = String(v).replace(/[%₹, ]+/g, '').trim()
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : null
}

function toIntOrDefault(v, defaultVal = 1) {
  if (v == null || v === '') return defaultVal
  const n = parseInt(String(v).replace(/[,\s]+/g, ''), 10)
  return Number.isFinite(n) && n > 0 ? n : defaultVal
}

function isNo(v) {
  return String(v || '').trim().toUpperCase() === 'NO'
}

function shouldSkipRow(row) {
  const brand = cleanText(row.brandname)
  const product = cleanText(row.productname)
  const style = cleanText(row.stylecode)
  return !brand && !product && !style
}

function normGender(v) {
  const s = String(v || '').trim().toUpperCase()
  if (s === 'MEN' || s === 'MANS' || s === 'MENS' || s === 'MALE') return 'MEN'
  if (s === 'WOMEN' || s === 'WOMENS' || s === 'LADIES' || s === 'FEMALE') return 'WOMEN'
  if (s === 'KIDS' || s === 'CHILD' || s === 'CHILDREN' || s === 'BOYS' || s === 'GIRLS') return 'KIDS'
  return 'WOMEN' // default
}

/**
 * POST /api/b2b/import
 * Body: multipart form with:
 *   - file: Excel file
 *   - gender: MEN | WOMEN | KIDS
 * Auth: requireAuth (any admin)
 */
router.post('/import', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' })

  const gender = normGender(req.body?.gender || 'WOMEN')

  let rows
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const sheetName = wb.SheetNames[0]
    const ws = wb.Sheets[sheetName]
    rows = XLSX.utils.sheet_to_json(ws, { defval: '' })
  } catch (e) {
    return res.status(400).json({ message: 'Failed to parse Excel file: ' + e.message })
  }

  if (!rows.length) return res.status(400).json({ message: 'Excel file is empty' })

  const results = { inserted: 0, updated: 0, skipped: 0, errors: [] }
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i]
      const row = normalizeB2BRow(raw)

      if (shouldSkipRow(row)) {
        results.skipped++
        continue
      }

      const brandName = cleanText(row.brandname)
      const productName = cleanText(row.productname)
      const styleCode = cleanText(row.stylecode)
      const mrp = toNumOrNull(row.mrp)
      const colour = cleanText(row.colour)
      const avbSizes = cleanText(row.avbsizes)
      const fit = cleanText(row.fit)
      const designPattern = cleanText(row.pattern)

      // Markdown: strip % sign, store as number e.g. -42
      const markdownRaw = toNumOrNull(row.markdownpct)
      const markdownPct = markdownRaw !== null ? Math.abs(markdownRaw) : null

      // Determine stock type
      const masterBoxVal = cleanText(row.masterbox)
      const isBoxed = !isNo(masterBoxVal) && masterBoxVal !== '' && toNumOrNull(masterBoxVal) !== null
      const stockUnit = isBoxed ? 'BOX' : 'PIECE'
      const piecesPerBox = isBoxed ? toIntOrDefault(masterBoxVal, 1) : null

      // Stock quantity
      // AVB QUANTITY PCS: if empty default to 1
      const avbQty = toIntOrDefault(row.avbqty, 1)
      const stockQty = avbQty

      if (!styleCode) {
        results.errors.push(`Row ${i + 2}: Missing EANCode/STYLE — skipped`)
        results.skipped++
        continue
      }

      if (!brandName) {
        results.errors.push(`Row ${i + 2}: Missing Brand Name — skipped`)
        results.skipped++
        continue
      }

      if (mrp === null || mrp <= 0) {
        results.errors.push(`Row ${i + 2}: Missing or invalid MRP for ${styleCode} — skipped`)
        results.skipped++
        continue
      }

      try {
        const existing = await client.query(
          'SELECT id FROM b2b_products WHERE style_code = $1',
          [styleCode]
        )

        if (existing.rowCount) {
          // Update existing — don't touch stock_qty (admin manages that manually)
          await client.query(
            `UPDATE b2b_products SET
               brand_name     = $2,
               product_name   = $3,
               gender         = $4,
               mrp            = $5,
               markdown_pct   = $6,
               stock_unit     = $7,
               pieces_per_box = $8,
               avb_sizes      = $9,
               colour         = $10,
               design_pattern = $11,
               fit            = $12,
               is_active      = TRUE,
               updated_at     = now()
             WHERE style_code = $1`,
            [
              styleCode, brandName, productName, gender,
              mrp, markdownPct, stockUnit, piecesPerBox,
              avbSizes || null, colour || null,
              designPattern || null, fit || null
            ]
          )
          results.updated++
        } else {
          // Insert new product with initial stock
          await client.query(
            `INSERT INTO b2b_products
               (style_code, brand_name, product_name, gender,
                mrp, markdown_pct, stock_unit, stock_qty, pieces_per_box,
                avb_sizes, colour, design_pattern, fit)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              styleCode, brandName, productName, gender,
              mrp, markdownPct, stockUnit, stockQty, piecesPerBox,
              avbSizes || null, colour || null,
              designPattern || null, fit || null
            ]
          )
          results.inserted++
        }
      } catch (rowErr) {
        results.errors.push(`Row ${i + 2} (${styleCode}): ${rowErr.message}`)
        results.skipped++
      }
    }

    await client.query('COMMIT')

    return res.json({
      ok: true,
      message: `Import complete. ${results.inserted} inserted, ${results.updated} updated, ${results.skipped} skipped.`,
      ...results
    })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('B2B import error:', e.message)
    return res.status(500).json({ message: 'Import failed: ' + e.message })
  } finally {
    client.release()
  }
})

module.exports = router
