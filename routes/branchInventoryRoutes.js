const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const pool = require('../db');
const { put } = require('@vercel/blob');
const axios = require('axios');
const unzipper = require('unzipper');
const { v2: cloudinary } = require('cloudinary');
const path = require('path');
const stream = require('stream');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

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
  if (!out.productname && raw['__EMPTY']) out.productname = raw['__EMPTY'];
  if (!out.brandname && raw['__EMPTY_1']) out.brandname = raw['__EMPTY_1'];
  if (out.purchaseqty == null && raw['__EMPTY_2'] != null) out.purchaseqty = raw['__EMPTY_2'];
  if (!out.eancode && raw['__EMPTY_3']) out.eancode = raw['__EMPTY_3'];
  if (out.mrp == null && raw['__EMPTY_4'] != null) out.mrp = raw['__EMPTY_4'];
  if (!out.size && raw['__EMPTY_5']) out.size = raw['__EMPTY_5'];
  if (!out.colour && raw['__EMPTY_6']) out.colour = raw['__EMPTY_6'];
  if (!out.pattern && raw['__EMPTY_7']) out.pattern = raw['__EMPTY_7'];
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

function extractEANFromName(name) {
  const m = String(name).match(/(\d{12,14})/);
  return m ? m[1] : null;
}

function uploadBufferToCloudinary(buffer, folder, publicId) {
  return new Promise((resolve, reject) => {
    const passthrough = new stream.PassThrough();
    const opts = { folder, public_id: publicId, overwrite: true, resource_type: 'image' };
    const up = cloudinary.uploader.upload_stream(opts, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    passthrough.end(buffer);
    passthrough.pipe(up);
  });
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
      const r = await pool.query(`SELECT * FROM import_jobs WHERE branch_id=$1 ORDER BY id DESC LIMIT 1`, [branchId]);
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
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
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
  const token = process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_RW_TOKEN;
  if (!token) return res.status(500).json({ message: 'Upload store not configured' });
  try {
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
    const j = await pool.query(
      `SELECT id, file_url, status_enum, rows_total, rows_success, rows_error, gender
       FROM import_jobs WHERE id = $1 AND branch_id = $2`,
      [jobId, branchId]
    );
    if (!j.rows.length) return res.status(404).json({ message: 'Job not found' });
    const job = j.rows[0];
    if (!job.file_url) return res.status(400).json({ message: 'Job has no file_url' });
    const st = String(job.status_enum || '').toUpperCase();
    if (st === 'COMPLETE' || st === 'PARTIAL' || st === 'FAILED') {
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
             DO UPDATE SET is_active = TRUE, mrp = EXCLUDED.mrp, sale_price = EXCLUDED.sale_price, cost_price = EXCLUDED.cost_price
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
             DO UPDATE SET on_hand = branch_variant_stock.on_hand + EXCLUDED.on_hand, is_active = TRUE`,
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
    let finalStatus = 'PENDING';
    if (isDone) {
      if (newSuccess === 0 && newError > 0) {
        finalStatus = 'FAILED';
      } else if (newError > 0) {
        finalStatus = 'PARTIAL';
      } else {
        finalStatus = 'COMPLETE';
      }
    }
    await pool.query(
      `UPDATE import_jobs
         SET rows_total   = $1,
             rows_success = $2,
             rows_error   = $3,
             status_enum  = $4,
             completed_at = CASE WHEN $4 = 'COMPLETE' OR $4 = 'PARTIAL' OR $4 = 'FAILED' THEN NOW() ELSE completed_at END
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

router.post('/:branchId/upload-images', requireBranchAuth, upload.single('imagesZip'), async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  if (!branchId || branchId !== Number(req.user.branch_id)) return res.status(403).json({ message: 'Forbidden' });
  if (!req.file) return res.status(400).json({ message: 'ZIP file required' });
  try {
    const zipBuffer = req.file.buffer;
    const zipStream = unzipper.Parse({ forceStream: true });
    const bufferStream = new stream.PassThrough();
    bufferStream.end(zipBuffer);
    bufferStream.pipe(zipStream);

    const uploaded = [];
    const tasks = [];

    zipStream.on('entry', (entry) => {
      const fileName = entry.path;
      const ext = path.extname(fileName).toLowerCase();
      if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        entry.autodrain();
        return;
      }
      const chunks = [];
      entry.on('data', (c) => chunks.push(c));
      entry.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ean = extractEANFromName(fileName);
        const base = path.basename(fileName, ext).replace(/[^\w-]+/g, '_');
        const publicId = ean || base;
        const folder = `products`;
        const t = uploadBufferToCloudinary(buf, folder, publicId).then((r) => {
          uploaded.push({ fileName, secure_url: r.secure_url, public_id: r.public_id, ean: ean || null });
        });
        tasks.push(t);
      });
    });

    zipStream.on('close', async () => {
      await Promise.all(tasks);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS product_images (
          ean_code text PRIMARY KEY,
          image_url text NOT NULL,
          uploaded_at timestamptz DEFAULT now()
        )
      `);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const img of uploaded) {
          if (!img.ean) continue;
          await client.query(
            `INSERT INTO product_images (ean_code, image_url, uploaded_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (ean_code) DO UPDATE SET image_url = EXCLUDED.image_url, uploaded_at = NOW()`,
            [img.ean, img.secure_url]
          );
          await client.query(
            `UPDATE product_variants v
               SET image_url = $2
             FROM barcodes b
             WHERE b.variant_id = v.id AND b.ean_code = $1`,
            [img.ean, img.secure_url]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        return res.status(500).json({ message: e.message || 'DB error' });
      } finally {
        client.release();
      }
      res.json({ totalUploaded: uploaded.length, images: uploaded });
    });

    zipStream.on('error', (e) => res.status(500).json({ message: e.message || 'ZIP parse error' }));
  } catch (e) {
    res.status(500).json({ message: e.message || 'Server error' });
  }
});

router.get('/:branchId/stock', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  if (!branchId || branchId !== Number(req.user.branch_id)) return res.status(403).json({ message: 'Forbidden' });
  const gender = normGender(req.query.gender || '');
  try {
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
         COALESCE(bc.ean_code,'') AS ean_code,
         COALESCE(v.image_url, pi.image_url, '') AS image_url
       FROM branch_variant_stock bvs
       JOIN product_variants v ON v.id = bvs.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN LATERAL (
         SELECT ean_code FROM barcodes bc WHERE bc.variant_id = v.id ORDER BY id ASC LIMIT 1
       ) bc ON TRUE
       LEFT JOIN product_images pi ON pi.ean_code = bc.ean_code
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
