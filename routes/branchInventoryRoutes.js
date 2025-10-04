const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const pool = require('../db');
const { put } = require('@vercel/blob');
const axios = require('axios');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const HEADER_ALIASES = {
  productname: ['product name', 'item', 'item name', 'productname'],
  brandname: ['brand', 'brand name', 'brandname'],
  costprice: ['cost', 'purchase cost', 'costprice'],
  purchaseqty: ['qty', 'quantity', 'purchase qty', 'purchaseqty'],
  eancode: ['ean', 'barcode', 'bar code', 'ean code', 'eancode'],
  mrp: ['mrp', '   mrp', 'mrp ', ' retail mrp ', 'mrp'],
  rsaleprice: ['retailprice', 'saleprice', 'sale price', 'retail price', 'rsp', 'rsaleprice'],
  markcode: ['mark code', 'mark', 'marking', 'markcode'],
  size: ['size', 'size '],
  colour: ['colour', 'color', 'colour ', 'color '],
  pattern: ['pattern code', 'style', 'style code', 'pattern'],
  fitt: ['fit', 'fit type', 'fitt']
};

function normalizeRow(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim().toLowerCase();
    out[key] = v;
  }
  for (const canon of Object.keys(HEADER_ALIASES)) {
    if (out[canon] != null && out[canon] !== '') continue;
    for (const alias of HEADER_ALIASES[canon]) {
      const a = String(alias).trim().toLowerCase();
      if (out[a] != null && out[a] !== '') {
        out[canon] = out[a];
        break;
      }
    }
  }
  return out;
}

function cleanText(v) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function toNumOrNull(v) {
  if (v === '' || v == null) return null;
  const n = parseFloat(String(v).toString().replace(/[, ]+/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toIntOrZero(v) {
  const n = parseInt(String(v).toString().replace(/[, ]+/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function normGender(v) {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'MEN' || s === 'WOMEN' || s === 'KIDS') return s;
  return '';
}

function requireBranchAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ message: 'Unauthorized' });
  }
}

async function ensureSchema() {
  const ddl = `
  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    brand_name TEXT NOT NULL,
    pattern_code TEXT,
    fit_type TEXT,
    mark_code TEXT,
    gender TEXT,
    UNIQUE(name, brand_name, pattern_code, gender)
  );
  CREATE TABLE IF NOT EXISTS product_variants (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    size TEXT NOT NULL,
    colour TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    mrp NUMERIC(12,2),
    sale_price NUMERIC(12,2),
    cost_price NUMERIC(12,2),
    UNIQUE(product_id, size, colour)
  );
  CREATE TABLE IF NOT EXISTS barcodes (
    id SERIAL PRIMARY KEY,
    variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    ean_code TEXT UNIQUE
  );
  CREATE TABLE IF NOT EXISTS branch_variant_stock (
    branch_id INTEGER NOT NULL,
    variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    on_hand INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (branch_id, variant_id)
  );
  CREATE TABLE IF NOT EXISTS import_jobs (
    id SERIAL PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_url TEXT NOT NULL,
    uploaded_by INTEGER,
    status_enum TEXT NOT NULL DEFAULT 'PENDING',
    rows_total INTEGER NOT NULL DEFAULT 0,
    rows_success INTEGER NOT NULL DEFAULT 0,
    rows_error INTEGER NOT NULL DEFAULT 0,
    uploaded_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP,
    branch_id INTEGER NOT NULL,
    gender TEXT
  );
  CREATE TABLE IF NOT EXISTS import_rows (
    id SERIAL PRIMARY KEY,
    import_job_id INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
    raw_row_json JSONB,
    status_enum TEXT,
    error_msg TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_products_gender ON products(gender);
  CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_name);
  CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
  CREATE INDEX IF NOT EXISTS idx_bvs_branch ON branch_variant_stock(branch_id);
  `;
  await pool.query(ddl);
}

async function ensureProductKeys() {
  const sql = `
    CREATE UNIQUE INDEX IF NOT EXISTS products_name_brand_pattern_gender_uniq
      ON public.products (name, brand_name, pattern_code, gender);
    CREATE UNIQUE INDEX IF NOT EXISTS product_variants_product_size_colour_uniq
      ON public.product_variants (product_id, size, colour);
    CREATE UNIQUE INDEX IF NOT EXISTS barcodes_ean_code_uniq
      ON public.barcodes (ean_code);
    CREATE UNIQUE INDEX IF NOT EXISTS branch_variant_stock_branch_variant_uniq
      ON public.branch_variant_stock (branch_id, variant_id);
  `;
  await pool.query(sql);
}

router.get('/:branchId/import-jobs', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  if (!branchId || branchId !== Number(req.user.branch_id)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const { rows } = await pool.query(
      `SELECT id, file_name, file_url, uploaded_by, status_enum, rows_total, rows_success, rows_error, uploaded_at, completed_at, branch_id, gender
       FROM import_jobs
       WHERE branch_id = $1
       ORDER BY id DESC
       LIMIT 100`,
      [branchId]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:branchId/import-rows', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  if (!branchId || branchId !== Number(req.user.branch_id)) return res.status(403).json({ message: 'Forbidden' });
  const jobId = req.query.jobId ? parseInt(req.query.jobId, 10) : null;
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '200', 10)));
  const status = String(req.query.status || '').trim();
  try {
    let job;
    if (jobId) {
      const r = await pool.query(`SELECT * FROM import_jobs WHERE id=$1 AND branch_id=$2`, [jobId, branchId]);
      if (!r.rows.length) return res.status(404).json({ message: 'Job not found' });
      job = r.rows[0];
    } else {
      const r = await pool.query(
        `SELECT * FROM import_jobs WHERE branch_id=$1 ORDER BY id DESC LIMIT 1`,
        [branchId]
      );
      if (!r.rows.length) return res.json({ job: null, rows: [], nextOffset: offset, total: 0 });
      job = r.rows[0];
    }
    const params = [job.id];
    let where = `import_job_id = $1`;
    if (status) {
      params.push(status);
      where += ` AND status_enum = $${params.length}`;
    }
    const totalQ = await pool.query(`SELECT COUNT(*)::int AS c FROM import_rows WHERE ${where}`, params);
    params.push(limit, offset);
    const rowsQ = await pool.query(
      `SELECT id, status_enum, error_msg, raw_row_json
       FROM import_rows
       WHERE ${where}
       ORDER BY id ASC
       LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    const nextOffset = offset + rowsQ.rows.length;
    res.json({
      job: {
        id: job.id,
        file_name: job.file_name,
        status_enum: job.status_enum,
        rows_total: job.rows_total,
        rows_success: job.rows_success,
        rows_error: job.rows_error,
        uploaded_at: job.uploaded_at,
        completed_at: job.completed_at,
        gender: job.gender
      },
      rows: rowsQ.rows,
      nextOffset,
      total: totalQ.rows[0].c
    });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:branchId/import', requireBranchAuth, upload.single('file'), async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  if (!branchId || branchId !== Number(req.user.branch_id)) return res.status(403).json({ message: 'Forbidden' });
  if (!req.file) return res.status(400).json({ message: 'File required' });
  const gender = normGender(req.body?.gender);
  if (!gender) return res.status(400).json({ message: 'Category is required (MEN/WOMEN/KIDS)' });
  const token =
    process.env.BLOB_READ_WRITE_TOKEN ||
    process.env.VERCEL_BLOB_READ_WRITE_TOKEN ||
    process.env.VERCEL_BLOB_RW_TOKEN;
  if (!token) return res.status(500).json({ message: 'Upload store not configured' });
  try {
    await ensureSchema();
    const ext = (req.file.originalname.split('.').pop() || 'xlsx').toLowerCase();
    const name = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const stored = await put(name, req.file.buffer, { access: 'public', contentType: req.file.mimetype, token });
    const { rows } = await pool.query(
      `INSERT INTO import_jobs (file_name, file_url, uploaded_by, status_enum, rows_total, rows_success, rows_error, branch_id, gender)
       VALUES ($1, $2, $3, 'PENDING', 0, 0, 0, $4, $5)
       RETURNING id, file_name, file_url, uploaded_by, status_enum, rows_total, rows_success, rows_error, uploaded_at, completed_at, branch_id, gender`,
      [req.file.originalname || name, stored.url, req.user.id, branchId, gender]
    );
    res.status(201).json(rows[0]);
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:branchId/import/process/:jobId', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  const jobId = parseInt(req.params.jobId, 10);
  const start = Math.max(0, parseInt(req.query.start || '0', 10));
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '200', 10)));
  if (!branchId || branchId !== Number(req.user.branch_id)) return res.status(403).json({ message: 'Forbidden' });
  try {
    await ensureSchema();
    await ensureProductKeys();
    const j = await pool.query(
      `SELECT id, file_url, status_enum, rows_total, rows_success, rows_error, gender
       FROM import_jobs WHERE id = $1 AND branch_id = $2`,
      [jobId, branchId]
    );
    if (!j.rows.length) return res.status(404).json({ message: 'Job not found' });
    const job = j.rows[0];
    if (!job.file_url) return res.status(400).json({ message: 'Job has no file_url' });
    const st = String(job.status_enum || '').toUpperCase();
    if (st === 'COMPLETE' || st === 'PARTIAL') {
      return res.json({ done: true, processed: 0, nextStart: start, ok: 0, err: 0, totalRows: job.rows_total || 0 });
    }
    const gender = normGender(job.gender);
    const resp = await axios.get(job.file_url, { responseType: 'arraybuffer' });
    const buf = Buffer.from(resp.data);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const wsName = wb.SheetNames && wb.SheetNames[0];
    if (!wsName) return res.status(400).json({ message: 'No worksheet in file' });
    const allRows = XLSX.utils.sheet_to_json(wb.Sheets[wsName], { defval: '' });
    const totalRows = allRows.length;
    const slice = allRows.slice(start, start + limit);
    let ok = 0;
    let err = 0;
    const errMap = new Map();
    const errSamples = [];
    const client = await pool.connect();
    try {
      for (const raw of slice) {
        const row = normalizeRow(raw);
        const ProductName = cleanText(row.productname);
        const BrandName = cleanText(row.brandname);
        const SIZE = cleanText(row.size);
        const COLOUR = cleanText(row.colour);
        const PATTERN = cleanText(row.pattern) || null;
        const FITT = cleanText(row.fitt) || null;
        const MarkCode = cleanText(row.markcode) || null;
        const MRP = toNumOrNull(row.mrp);
        const RSalePrice = toNumOrNull(row.rsaleprice);
        const CostPrice = toNumOrNull(row.costprice) ?? 0;
        const PurchaseQty = toIntOrZero(row.purchaseqty);
        let EANCode = row.eancode;
        if (EANCode != null && EANCode !== '') EANCode = cleanText(EANCode);
        if (!ProductName || !BrandName || !SIZE || !COLOUR) {
          const msg = 'Missing required fields (ProductName/BrandName/SIZE/COLOUR)';
          err++;
          await client.query(
            `INSERT INTO import_rows (import_job_id, raw_row_json, status_enum, error_msg)
             VALUES ($1, $2::jsonb, $3, $4)`,
            [jobId, JSON.stringify(raw), 'ERROR', msg]
          );
          errMap.set(msg, (errMap.get(msg) || 0) + 1);
          if (errSamples.length < 5) errSamples.push({ row: raw, error: msg });
          continue;
        }
        try {
          await client.query('BEGIN');
          const pRes = await client.query(
            `INSERT INTO products (name, brand_name, pattern_code, fit_type, mark_code, gender)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (name, brand_name, pattern_code, gender)
             DO UPDATE SET fit_type = EXCLUDED.fit_type,
                           mark_code = EXCLUDED.mark_code
             RETURNING id`,
            [ProductName, BrandName, PATTERN, FITT, MarkCode, gender || null]
          );
          const productId = pRes.rows[0].id;
          const vRes = await client.query(
            `INSERT INTO product_variants (product_id, size, colour, is_active, mrp, sale_price, cost_price)
             VALUES ($1, $2, $3, TRUE, $4, $5, $6)
             ON CONFLICT (product_id, size, colour)
             DO UPDATE SET is_active = TRUE,
                           mrp = EXCLUDED.mrp,
                           sale_price = EXCLUDED.sale_price,
                           cost_price = EXCLUDED.cost_price
             RETURNING id`,
            [productId, SIZE, COLOUR, MRP, RSalePrice, CostPrice]
          );
          const variantId = vRes.rows[0].id;
          if (EANCode) {
            await client.query(
              `INSERT INTO barcodes (variant_id, ean_code)
               VALUES ($1, $2)
               ON CONFLICT (ean_code) DO UPDATE SET variant_id = EXCLUDED.variant_id`,
              [variantId, EANCode]
            );
          }
          await client.query(
            `INSERT INTO branch_variant_stock (branch_id, variant_id, on_hand, reserved, is_active)
             VALUES ($1, $2, $3, 0, TRUE)
             ON CONFLICT (branch_id, variant_id)
             DO UPDATE SET on_hand = branch_variant_stock.on_hand + EXCLUDED.on_hand,
                           is_active = TRUE`,
            [branchId, variantId, PurchaseQty]
          );
          await client.query(
            `INSERT INTO import_rows (import_job_id, raw_row_json, status_enum, error_msg)
             VALUES ($1, $2::jsonb, $3, $4)`,
            [jobId, JSON.stringify(raw), 'OK', null]
          );
          await client.query('COMMIT');
          ok++;
        } catch (e) {
          await client.query('ROLLBACK');
          err++;
          const msg = String(e.message || 'error').slice(0, 500);
          await client.query(
            `INSERT INTO import_rows (import_job_id, raw_row_json, status_enum, error_msg)
             VALUES ($1, $2::jsonb, $3, $4)`,
            [jobId, JSON.stringify(raw), 'ERROR', msg]
          );
          errMap.set(msg, (errMap.get(msg) || 0) + 1);
          if (errSamples.length < 5) errSamples.push({ row: raw, error: msg });
        }
      }
    } finally {
      client.release();
    }
    const newSuccess = (job.rows_success || 0) + ok;
    const newError = (job.rows_error || 0) + err;
    const rowsDone = start + slice.length;
    const isDone = rowsDone >= totalRows;
    const finalStatus = isDone ? (newError > 0 ? 'PARTIAL' : 'COMPLETE') : 'PENDING';
    await pool.query(
      `UPDATE import_jobs
         SET rows_total   = $1,
             rows_success = $2,
             rows_error   = $3,
             status_enum  = $4,
             completed_at = CASE WHEN $4 = 'COMPLETE' OR $4 = 'PARTIAL' THEN NOW() ELSE completed_at END
       WHERE id = $5`,
      [totalRows, newSuccess, newError, finalStatus, jobId]
    );
    const error_counts = Array.from(errMap.entries())
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    res.json({
      done: isDone,
      processed: slice.length,
      ok,
      err,
      totalRows,
      nextStart: rowsDone,
      error_counts,
      errors_sample: errSamples
    });
  } catch (e) {
    res.status(500).json({ message: e?.message || 'Server error' });
  }
});

router.get('/:branchId/stock', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  if (!branchId || branchId !== Number(req.user.branch_id)) return res.status(403).json({ message: 'Forbidden' });
  const gender = normGender(req.query.gender || '');
  try {
    await ensureSchema();
    const params = [branchId];
    let where = `bvs.branch_id = $1 AND bvs.is_active = TRUE`;
    if (gender) {
      params.push(gender);
      where += ` AND p.gender = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT
         p.id AS product_id,
         p.name AS product_name,
         p.brand_name,
         p.pattern_code,
         p.fit_type,
         p.mark_code,
         p.gender,
         v.id AS variant_id,
         v.size,
         v.colour,
         v.mrp,
         v.sale_price,
         v.cost_price,
         bvs.on_hand,
         bvs.reserved,
         COALESCE(bc.ean_code,'') AS ean_code
       FROM branch_variant_stock bvs
       JOIN product_variants v ON v.id = bvs.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN LATERAL (
         SELECT ean_code FROM barcodes bc WHERE bc.variant_id = v.id ORDER BY id ASC LIMIT 1
       ) bc ON TRUE
       WHERE ${where}
       ORDER BY p.brand_name, p.name, v.size, v.colour`,
      params
    );
    res.json(rows);
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
