const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const pool = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

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

router.get('/:branchId/import-jobs', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  if (!branchId || branchId !== Number(req.user.branch_id)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const { rows } = await pool.query(
      `SELECT id, file_name, uploaded_by, status_enum, rows_total, rows_success, rows_error, uploaded_at, completed_at, branch_id
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

router.post('/:branchId/import', requireBranchAuth, upload.single('file'), async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  if (!branchId || branchId !== Number(req.user.branch_id)) return res.status(403).json({ message: 'Forbidden' });
  if (!req.file) return res.status(400).json({ message: 'File required' });

  const client = await pool.connect();
  let jobId = null;

  try {
    const fileName = req.file.originalname || `upload_${Date.now()}.xlsx`;

    const insertJob = await client.query(
      `INSERT INTO import_jobs (file_name, uploaded_by, status_enum, rows_total, rows_success, rows_error, branch_id)
       VALUES ($1, $2, 'PENDING', 0, 0, 0, $3)
       RETURNING id`,
      [fileName, req.user.id, branchId]
    );
    jobId = insertJob.rows[0].id;

    let wb, wsName, rows;
    try {
      wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      wsName = wb.SheetNames && wb.SheetNames[0];
      if (!wsName) {
        await client.query(
          `UPDATE import_jobs SET status_enum = 'FAILED', completed_at = NOW() WHERE id = $1`,
          [jobId]
        );
        return res.status(400).json({ message: 'No worksheet found in the file' });
      }
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wsName], { defval: '' });
      if (!Array.isArray(rows)) rows = [];
    } catch {
      await client.query(
        `UPDATE import_jobs SET status_enum = 'FAILED', completed_at = NOW() WHERE id = $1`,
        [jobId]
      );
      return res.status(400).json({ message: 'Could not read the uploaded file' });
    }

    let total = rows.length;
    let ok = 0;
    let err = 0;

    for (const raw of rows) {
      const ProductName = String(raw.ProductName || raw.productname || raw['Product Name'] || '').trim();
      const BrandName = String(raw.BrandName || raw.brandname || raw.Brand || '').trim();
      const CostPrice = parseFloat(String(raw.CostPrice || raw.costprice || raw.Cost || 0)) || 0;
      const PurchaseQty = parseInt(String(raw.PurchaseQty || raw.purchaseqty || raw.Qty || 0), 10) || 0;
      const EANCode = String(raw.EANCode || raw.eancode || raw.EAN || raw.Barcode || '').trim();
      const MRP = parseFloat(String(raw.MRP || raw.mrp || 0)) || null;
      const RSalePrice = parseFloat(String(raw.RSalePrice || raw.RetailPrice || raw.SalePrice || 0)) || null;
      const TaxName = String(raw.TaxName || raw.taxname || '').trim();
      const MarkCode = String(raw.MarkCode || raw.markcode || raw['Mark Code'] || '').trim();
      const SIZE = String(raw.SIZE || raw.Size || '').trim();
      const COLOUR = String(raw.COLOUR || raw.Colour || raw.Color || '').trim();
      const PATTERN = String(raw.PATTERN || raw.Pattern || '').trim();
      const FITT = String(raw.FITT || raw.Fit || '').trim();

      if (!ProductName || !BrandName || !SIZE || !COLOUR) {
        err++;
        await client.query(
          `INSERT INTO import_rows (import_job_id, raw_row_json, status_enum, error_msg)
           VALUES ($1, $2::jsonb, 'ERROR', $3)`,
          [jobId, JSON.stringify(raw), 'Missing required fields']
        );
        continue;
      }

      try {
        await client.query('BEGIN');

        const pRes = await client.query(
          `INSERT INTO products (name, brand_name, pattern_code, fit_type, mark_code)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (name, brand_name, pattern_code)
           DO UPDATE SET fit_type = EXCLUDED.fit_type, mark_code = EXCLUDED.mark_code
           RETURNING id`,
          [ProductName, BrandName, PATTERN || null, FITT || null, MarkCode || null]
        );
        const productId = pRes.rows[0].id;

        const vRes = await client.query(
          `INSERT INTO product_variants (product_id, size, colour, is_active, mrp, sale_price, cost_price)
           VALUES ($1,$2,$3,TRUE,$4,$5,$6)
           ON CONFLICT (product_id, size, colour)
           DO UPDATE SET is_active = TRUE, mrp = EXCLUDED.mrp, sale_price = EXCLUDED.sale_price, cost_price = EXCLUDED.cost_price
           RETURNING id`,
          [productId, SIZE, COLOUR, MRP, RSalePrice, CostPrice]
        );
        const variantId = vRes.rows[0].id;

        if (EANCode) {
          await client.query(
            `INSERT INTO barcodes (variant_id, ean_code)
             VALUES ($1,$2)
             ON CONFLICT (ean_code) DO UPDATE SET variant_id = EXCLUDED.variant_id`,
            [variantId, EANCode]
          );
        }

        await client.query(
          `INSERT INTO branch_variant_stock (branch_id, variant_id, on_hand, reserved, is_active)
           VALUES ($1,$2,$3,0,TRUE)
           ON CONFLICT (branch_id, variant_id)
           DO UPDATE SET on_hand = branch_variant_stock.on_hand + EXCLUDED.on_hand, is_active = TRUE`,
          [branchId, variantId, PurchaseQty]
        );

        await client.query(
          `INSERT INTO import_rows (import_job_id, raw_row_json, status_enum, error_msg)
           VALUES ($1,$2::jsonb,'OK',NULL)`,
          [jobId, JSON.stringify(raw)]
        );

        await client.query('COMMIT');
        ok++;
      } catch (e) {
        await client.query('ROLLBACK');
        err++;
        await client.query(
          `INSERT INTO import_rows (import_job_id, raw_row_json, status_enum, error_msg)
           VALUES ($1,$2::jsonb,'ERROR',$3)`,
          [jobId, JSON.stringify(raw), String(e.message || 'error').slice(0, 500)]
        );
      }
    }

    const status = err ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
    await client.query(
      `UPDATE import_jobs
       SET status_enum = $1, rows_total = $2, rows_success = $3, rows_error = $4, completed_at = NOW()
       WHERE id = $5`,
      [status, total, ok, err, jobId]
    );

    res.status(201).json({ id: jobId, file_name: req.file.originalname || null, uploaded_by: req.user.id, status_enum: status, rows_total: total, rows_success: ok, rows_error: err, branch_id: branchId });
  } catch {
    if (jobId) {
      try {
        await client.query(
          `UPDATE import_jobs SET status_enum = 'FAILED', completed_at = NOW() WHERE id = $1`,
          [jobId]
        );
      } catch {}
    }
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

router.get('/:branchId/stock', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  if (!branchId || branchId !== Number(req.user.branch_id)) return res.status(403).json({ message: 'Forbidden' });
  try {
    const { rows } = await pool.query(
      `SELECT
         p.id AS product_id,
         p.name AS product_name,
         p.brand_name,
         p.pattern_code,
         p.fit_type,
         p.mark_code,
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
       WHERE bvs.branch_id = $1 AND bvs.is_active = TRUE
       ORDER BY p.brand_name, p.name, v.size, v.colour`,
      [branchId]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
