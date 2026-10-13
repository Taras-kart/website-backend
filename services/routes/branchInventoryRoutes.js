const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const pool = require('../db');
const {
  put
} = require('@vercel/blob');
const router = express.Router();
const {saveVariant,validateVariant}=require('../services/catalogueWrite');
const crypto=require('crypto');
const {
  parsePackImport
} = require('../utils/packImport');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});
const IMPORT_ROW_STATUS_CREATED = 'CREATED';
const IMPORT_ROW_STATUS_OK = 'OK';
const IMPORT_ROW_STATUS_ERROR = 'ERROR';
const HEADER_ALIASES = {
  packsize: ['pack size', 'pack_size', 'pieces per pack', 'pcs per pack'],
  productname: ['product', 'product name', 'item', 'item name', 'productname'],
  brandname: ['brand', 'brand name', 'brandname'],
  costprice: ['cost', 'purchase cost', 'costprice'],
  eancode: ['ean', 'barcode', 'bar code', 'ean code', 'eancode', 'eancode/style', 'ean code/style'],
  purchaseqty: ['clqty', 'qty', 'quantity', 'purchase qty', 'purchaseqty', 'avb quantity pcs', 'avb qty', 'available quantity'],
  b2cdiscount: ['b2cdiscount', 'b2c discount', 'discount_b2c', 'b2c disc', 'b2c_disc', 'b to c discount'],
  mrp: ['mrp', '   mrp', 'mrp ', ' retail mrp ', 'mrp'],
  rsaleprice: ['retailprice', 'saleprice', 'sale price', 'retail price', 'rsp', 'rsaleprice'],
  markcode: ['mark code', 'mark', 'marking', 'markcode'],
  size: ['size', 'size '],
  colour: ['colour', 'color', 'colour ', 'color '],
  pattern: ['design code', 'design_code', 'pattern code', 'style', 'style code', 'pattern', 'design pattern'],
  fitt: ['fit', 'fit type', 'fitt'],
  b2bdiscount: ['b2bdiscount', 'b2b discount', 'discount_b2b', 'b2b disc', 'b2b_disc']
};
function normalizeRow(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
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
  if (!out.productname && raw && raw.__EMPTY) out.productname = raw.__EMPTY;
  if (!out.brandname && raw && raw.__EMPTY_1) out.brandname = raw.__EMPTY_1;
  if (out.purchaseqty == null && raw && raw.__EMPTY_2 != null) out.purchaseqty = raw.__EMPTY_2;
  if (!out.eancode && raw && raw.__EMPTY_3) out.eancode = raw.__EMPTY_3;
  if (out.mrp == null && raw && raw.__EMPTY_4 != null) out.mrp = raw.__EMPTY_4;
  if (!out.size && raw && raw.__EMPTY_5) out.size = raw.__EMPTY_5;
  if (!out.colour && raw && raw.__EMPTY_6) out.colour = raw.__EMPTY_6;
  if (!out.pattern && raw && raw.__EMPTY_7) out.pattern = raw.__EMPTY_7;
  return out;
}
function cleanText(v) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}
function toNumOrNull(v) {
  if (v === '' || v == null) return null;
  const n = parseFloat(String(v).replace(/[₹, ]+/g, ''));
  return Number.isFinite(n) ? n : null;
}
function toIntOrZero(v) {
  const n = parseInt(String(v).replace(/[₹, ]+/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}
function normGender(v) {
  const s = String(v || '').trim().toUpperCase();
  if (s === 'MEN' || s === 'WOMEN' || s === 'KIDS') return s;
  if (s === 'MAN' || s === 'MALE' || s === 'MENS' || s === "MEN'S") return 'MEN';
  if (s === 'WOMAN' || s === 'FEMALE' || s === 'LADIES' || s === 'WOMENS' || s === "WOMEN'S") return 'WOMEN';
  if (s === 'CHILD' || s === 'CHILDREN' || s === 'BOYS' || s === 'GIRLS' || s === 'KID') return 'KIDS';
  return '';
}
function positiveInteger(v) {
  const n = Number.parseInt(String(v || ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}
async function loadImportCategory(db, categoryId, gender) {
  const result = await db.query(`SELECT id, parent_id, gender, name, slug, level, is_active
     FROM product_categories
     WHERE id = $1`, [categoryId]);
  if (!result.rows.length) return {
    error: 'Selected category does not exist'
  };
  const category = result.rows[0];
  if (!category.is_active) return {
    error: 'Selected category is inactive'
  };
  if (category.parent_id == null || Number(category.level) < 1) return {
    error: 'Select a product category, not a root gender'
  };
  if (normGender(category.gender) !== gender) return {
    error: 'Selected category does not belong to the selected gender'
  };
  return {
    category
  };
}
const requireBranchAuth = require('../middleware/auth').requireAuth
function extractEANFromName(name) {
  const base = String(name ?? '').trim().split(/[\\/]/).pop().replace(/\.(?:jpe?g|png|webp|gif|avif|bmp)$/i, '').trim();
  return base || null;
}
function isSummaryOrBlankRow(raw, ProductName, BrandName, SIZE, COLOUR, row) {
  const summary = cleanText(raw && (raw['Stock Summary'] || raw['stock summary']) || '');
  const allMainEmpty = !ProductName && !BrandName && !SIZE && !COLOUR;
  const hasAnyDataField = cleanText(row.eancode) || toNumOrNull(row.mrp) != null || toNumOrNull(row.rsaleprice) != null || toIntOrZero(row.purchaseqty) !== 0;
  if (allMainEmpty && !hasAnyDataField) return true;
  const s = summary.toLowerCase();
  if (!summary) return false;
  if (s.startsWith('date between')) return true;
  if (s.startsWith('| branchs')) return true;
  return false;
}
function isDefaultText(v) {
  const t = cleanText(v).toLowerCase();
  if (!t) return true;
  const badExact = new Set(['brand', 'product', 'new in', 'inclusive of all taxes', '₹0.00', '0', '0.00', '₹0', '₹0.0', '₹0.00']);
  if (badExact.has(t)) return true;
  const badContains = ['inclusive of all taxes', 'new in'];
  if (badContains.some(x => t.includes(x))) return true;
  return false;
}
function shouldSkipBusinessRow(ProductName, BrandName, MRP, RSalePrice) {
  const mrp0 = MRP == null ? null : Number(MRP);
  const sale0 = RSalePrice == null ? null : Number(RSalePrice);
  const bothZero = (mrp0 === 0 || mrp0 === null) && (sale0 === 0 || sale0 === null);
  if (!bothZero) return false;
  return isDefaultText(ProductName) || isDefaultText(BrandName);
}
async function ensureImportRowsTable() { return true; }

function rowToPreparedRecord(raw) {
  const row = normalizeRow(raw);
  const ProductName = cleanText(row.productname);
  const BrandName = cleanText(row.brandname);
  const SIZE = cleanText(row.size);
  const COLOUR = cleanText(row.colour);
  const PATTERN = cleanText(row.pattern) || null;
  const FITT = cleanText(row.fitt);
  const MarkCode = cleanText(row.markcode) || null;
  const MRP = toNumOrNull(row.mrp);
  const RSalePrice = toNumOrNull(row.rsaleprice);
  const CostPrice = toNumOrNull(row.costprice) ?? 0;
  const pack = parsePackImport(row);
  const PurchaseQty = pack.quantity ?? 0;
  const PackSize = pack.packSize ?? 1;
  const PackError = pack.error || null;
  const B2CDiscount = toNumOrNull(row.b2cdiscount) ?? 0;
  const B2BDiscount = toNumOrNull(row.b2bdiscount) ?? 0;
  let EANCode = row.eancode;
  if (EANCode != null && EANCode !== '') EANCode = cleanText(EANCode);
  return {
    raw,
    ProductName,
    BrandName,
    SIZE,
    COLOUR,
    PATTERN,
    FITT,
    MarkCode,
    MRP,
    RSalePrice,
    CostPrice,
    PurchaseQty,
    PackSize,
    PackError,
    B2CDiscount,
    B2BDiscount,
    EANCode
  };
}
function shouldQueueRow(prepared) {
  if (isSummaryOrBlankRow(prepared.raw, prepared.ProductName, prepared.BrandName, prepared.SIZE, prepared.COLOUR, normalizeRow(prepared.raw))) {
    return false;
  }
  if (shouldSkipBusinessRow(prepared.ProductName, prepared.BrandName, prepared.MRP, prepared.RSalePrice)) {
    return false;
  }
  return true;
}
async function getAllowedImportRowStatuses() {
  const sql = `
    SELECT enumlabel
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'import_row_status'
    ORDER BY enumsortorder
  `;
  const {
    rows
  } = await pool.query(sql);
  return rows.length ? rows.map(r => r.enumlabel) : ['CREATED','OK','ERROR'];
}
function resolveCreatedStatus(enumValues) {
  if (enumValues.includes('CREATED')) return 'CREATED';
  return null;
}
function resolveOkStatus(enumValues) {
  if (enumValues.includes('OK')) return 'OK';
  return null;
}
function resolveErrorStatus(enumValues) {
  if (enumValues.includes('ERROR')) return 'ERROR';
  return null;
}
async function insertImportRowsInBatches(client, jobId, rows, createdStatus) {
  const chunkSize = 250;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const params = [];
    let p = 1;
    for (const item of chunk) {
      values.push(`($${p++}, $${p++}::jsonb, $${p++}, NULL)`);
      params.push(jobId, JSON.stringify(item.raw), createdStatus);
    }
    await client.query(`INSERT INTO import_rows (import_job_id, raw_row_json, status_enum, error_msg)
       VALUES ${values.join(',')}`, params);
  }
}
router.get('/:branchId/import-jobs', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  const isSuperAdmin = String(req.user?.role || req.user?.role_enum || '').toUpperCase() === 'SUPER_ADMIN';
  if (!isSuperAdmin && (!branchId || branchId !== Number(req.user.branch_id))) return res.status(403).json({
    message: 'Forbidden'
  });
  try {
    const {
      rows
    } = await pool.query(`SELECT j.id, j.file_name, j.file_url, j.uploaded_by, j.status_enum, j.rows_total, j.rows_success, j.rows_error,
              j.uploaded_at, j.completed_at, j.branch_id, j.gender, j.category_id,
              c.name AS category_name, c.slug AS category_slug
       FROM import_jobs j
       LEFT JOIN product_categories c ON c.id = j.category_id
       WHERE j.branch_id = $1
       ORDER BY j.id DESC
       LIMIT 100`, [branchId]);
    res.json(rows);
  } catch {
    res.status(500).json({
      message: 'Server error'
    });
  }
});
router.get('/:branchId/import-rows', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  const isSuperAdmin = String(req.user?.role || req.user?.role_enum || '').toUpperCase() === 'SUPER_ADMIN';
  if (!isSuperAdmin && (!branchId || branchId !== Number(req.user.branch_id))) return res.status(403).json({
    message: 'Forbidden'
  });
  const jobId = req.query.jobId ? parseInt(req.query.jobId, 10) : null;
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '200', 10)));
  const status = String(req.query.status || '').trim();
  try {
    await ensureImportRowsTable();
    let job;
    if (jobId) {
      const r = await pool.query(`SELECT j.*, c.name AS category_name, c.slug AS category_slug
         FROM import_jobs j
         LEFT JOIN product_categories c ON c.id = j.category_id
         WHERE j.id=$1 AND j.branch_id=$2`, [jobId, branchId]);
      if (!r.rows.length) return res.status(404).json({
        message: 'Job not found'
      });
      job = r.rows[0];
    } else {
      const r = await pool.query(`SELECT j.*, c.name AS category_name, c.slug AS category_slug
         FROM import_jobs j
         LEFT JOIN product_categories c ON c.id = j.category_id
         WHERE j.branch_id=$1
         ORDER BY j.id DESC
         LIMIT 1`, [branchId]);
      if (!r.rows.length) return res.json({
        job: null,
        rows: [],
        nextOffset: offset,
        total: 0
      });
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
    const rowsQ = await pool.query(`SELECT id, status_enum, error_msg, raw_row_json
       FROM import_rows
       WHERE ${where}
       ORDER BY id ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
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
        gender: job.gender,
        category_id: job.category_id,
        category_name: job.category_name,
        category_slug: job.category_slug
      },
      rows: rowsQ.rows,
      nextOffset,
      total: totalQ.rows[0].c
    });
  } catch {
    res.status(500).json({
      message: 'Server error'
    });
  }
});
router.post('/:branchId/import', requireBranchAuth, upload.single('file'), async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  const isSuperAdmin = String(req.user?.role || req.user?.role_enum || '').toUpperCase() === 'SUPER_ADMIN';
  if (!isSuperAdmin && (!branchId || branchId !== Number(req.user.branch_id))) return res.status(403).json({
    message: 'Forbidden'
  });
  if (!req.file) return res.status(400).json({
    message: 'File required'
  });
  const gender = normGender(req.body?.gender);
  if (!gender) return res.status(400).json({
    message: 'Gender is required (MEN/WOMEN/KIDS)'
  });
  const categoryId = positiveInteger(req.body?.categoryId || req.body?.category_id);
  if (!categoryId) return res.status(400).json({
    message: 'Category is required'
  });
  const token = process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_RW_TOKEN;
  
  const client = await pool.connect();
  try {
    await ensureImportRowsTable();
    const categoryCheck = await loadImportCategory(client, categoryId, gender);
    if (categoryCheck.error) return res.status(400).json({
      message: categoryCheck.error
    });
    const category = categoryCheck.category;
    const enumValues = await getAllowedImportRowStatuses();
    const createdStatus = resolveCreatedStatus(enumValues);
    if (!createdStatus) {
      return res.status(500).json({
        message: `import_row_status enum is missing CREATED. Available values: ${enumValues.join(', ')}`
      });
    }
    if (!/\.(xlsx|xls|csv)$/i.test(req.file.originalname)) return res.status(400).json({message:'Upload an Excel or CSV file'});
    const wb = XLSX.read(req.file.buffer, {type:'buffer',sheetRows:20002});
    const wsName = wb.SheetNames && wb.SheetNames[0];
    if (!wsName) return res.status(400).json({
      message: 'No worksheet in file'
    });
    const allRows = XLSX.utils.sheet_to_json(wb.Sheets[wsName], {
      defval: ''
    });
    const preparedRows = [];
    for (const raw of allRows) {
      const prepared = rowToPreparedRecord(raw);
      if (shouldQueueRow(prepared)) preparedRows.push(prepared);
    }
    if (!preparedRows.length || preparedRows.length > 20000) return res.status(400).json({message:'Upload between 1 and 20,000 data rows'});
    const seen = new Set();
    for (let i=0;i<preparedRows.length;i++) {
      const r=preparedRows[i];
      try {
        if(r.PackError) throw new Error(r.PackError);
        validateVariant({name:r.ProductName,brand:r.BrandName,size:r.SIZE,colour:r.COLOUR,pattern:r.PATTERN,fit:r.FITT,ean:r.EANCode,gender,category_id:categoryId,mrp:r.MRP,sale_price:r.RSalePrice,cost_price:r.CostPrice,b2c_discount_pct:r.B2CDiscount,b2b_discount_pct:r.B2BDiscount,quantity:r.PurchaseQty,pack_size:r.PackSize});
        if(r.EANCode&&seen.has(r.EANCode)) throw new Error('Repeated barcode in this file');
        if(r.EANCode) seen.add(r.EANCode);
      } catch(e) {return res.status(400).json({message:`Excel row ${i+2}: ${e.message}`});}
    }
    const hash=crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const duplicate=await client.query('SELECT * FROM import_jobs WHERE branch_id=$1 AND category_id=$2 AND file_hash=$3',[branchId,categoryId,hash]);
    if(duplicate.rows.length) return res.json({...duplicate.rows[0],reused:true});
    const ext = (req.file.originalname.split('.').pop() || 'xlsx').toLowerCase();
    const name = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const stored = {url:''};
    await client.query('BEGIN');
    const {
      rows
    } = await client.query(`INSERT INTO import_jobs (file_name, file_url, uploaded_by, status_enum, rows_total, rows_success, rows_error, branch_id, gender, category_id, file_hash)
       VALUES ($1, $2, $3, 'PENDING', $4, 0, 0, $5, $6, $7, $8)
       RETURNING id, file_name, file_url, uploaded_by, status_enum, rows_total, rows_success, rows_error, uploaded_at, completed_at, branch_id, gender, category_id`, [req.file.originalname || name, stored.url, req.user.id, preparedRows.length, branchId, gender, categoryId, hash]);
    const job = rows[0];
    if (preparedRows.length) {
      await insertImportRowsInBatches(client, job.id, preparedRows, createdStatus);
    }
    await client.query('COMMIT');
    res.status(201).json({
      ...job,
      category_name: category.name,
      category_slug: category.slug
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({
      message: e.message || 'Server error'
    });
  } finally {
    client.release();
  }
});
router.post('/:branchId/import/process/:jobId', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  const jobId = parseInt(req.params.jobId, 10);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '100', 10)));
  const isSuperAdmin = String(req.user?.role || req.user?.role_enum || '').toUpperCase() === 'SUPER_ADMIN';
  if (!isSuperAdmin && (!branchId || branchId !== Number(req.user.branch_id))) return res.status(403).json({
    message: 'Forbidden'
  });
  try {
    await ensureImportRowsTable();
    const enumValues = await getAllowedImportRowStatuses();
    const createdStatus = resolveCreatedStatus(enumValues);
    const okStatus = resolveOkStatus(enumValues);
    const errorStatus = resolveErrorStatus(enumValues);
    if (!createdStatus || !okStatus || !errorStatus) {
      return res.status(500).json({
        message: `Unsupported import_row_status enum values: ${enumValues.join(', ')}`
      });
    }
    const j = await pool.query(`SELECT id, file_url, status_enum, rows_total, rows_success, rows_error, gender, category_id
       FROM import_jobs
       WHERE id = $1 AND branch_id = $2`, [jobId, branchId]);
    if (!j.rows.length) return res.status(404).json({
      message: 'Job not found'
    });
    const job = j.rows[0];
    const st = String(job.status_enum || '').toUpperCase();
    const gender = normGender(job.gender);
    const categoryId = positiveInteger(job.category_id);
    if (!gender || !categoryId) return res.status(400).json({
      message: 'Import job is missing its gender or category'
    });
    const categoryCheck = await loadImportCategory(pool, categoryId, gender);
    if (categoryCheck.error) return res.status(400).json({
      message: categoryCheck.error
    });
    if (st === 'COMPLETE' || st === 'PARTIAL' || st === 'FAILED') {
      return res.json({
        done: true,
        processed: 0,
        nextStart: (job.rows_success || 0) + (job.rows_error || 0),
        ok: 0,
        err: 0,
        totalRows: job.rows_total || 0
      });
    }
    const client = await pool.connect();
    let ok = 0;
    let err = 0;
    const errMap = new Map();
    const errSamples = [];
    try {
      const locked=await client.query('SELECT pg_try_advisory_lock(73498,$1) locked',[jobId]);
      if (!locked.rows[0].locked) return res.status(409).json({message:'This import is already processing. Wait, then resume.'});
      const batch = await client.query(`SELECT id, raw_row_json
         FROM import_rows
         WHERE import_job_id = $1 AND status_enum = $2
         ORDER BY id ASC
         LIMIT $3`, [jobId, createdStatus, limit]);
      const rowsToProcess = batch.rows;
      if (!rowsToProcess.length) {
        const finalSuccess = job.rows_success || 0;
        const finalError = job.rows_error || 0;
        const finalStatus = finalSuccess === 0 && finalError > 0 ? 'FAILED' : finalError > 0 ? 'PARTIAL' : 'COMPLETE';
        await pool.query(`UPDATE import_jobs
           SET status_enum = $1,
               completed_at = NOW()
           WHERE id = $2`, [finalStatus, jobId]);
        return res.json({
          done: true,
          processed: 0,
          nextStart: finalSuccess + finalError,
          ok: 0,
          err: 0,
          totalRows: job.rows_total || 0
        });
      }
      for (const batchRow of rowsToProcess) {
        const raw = batchRow.raw_row_json || {};
        const prepared = rowToPreparedRecord(raw);
        if (prepared.PackError || !prepared.ProductName || !prepared.BrandName || !prepared.SIZE || !prepared.COLOUR) {
          const msg = prepared.PackError || 'Missing required fields (ProductName/BrandName/SIZE/COLOUR)';
          await client.query(`UPDATE import_rows
             SET status_enum = $2,
                 error_msg = $3,
                 processed_at = NOW()
             WHERE id = $1`, [batchRow.id, errorStatus, msg]);
          err += 1;
          errMap.set(msg, (errMap.get(msg) || 0) + 1);
          if (errSamples.length < 5) errSamples.push({
            row: raw,
            error: msg
          });
          continue;
        }
        try {
          await client.query('BEGIN');
          await saveVariant(client,{name:prepared.ProductName,brand:prepared.BrandName,size:prepared.SIZE,colour:prepared.COLOUR,pattern:prepared.PATTERN,fit:prepared.FITT,ean:prepared.EANCode,gender,category_id:categoryId,mrp:prepared.MRP,sale_price:prepared.RSalePrice,cost_price:prepared.CostPrice,b2c_discount_pct:prepared.B2CDiscount,b2b_discount_pct:prepared.B2BDiscount,quantity:prepared.PurchaseQty,pack_size:prepared.PackSize},branchId,req.user,{reference:`IMPORT:${jobId}:${batchRow.id}`});
          await client.query(`UPDATE import_rows
             SET status_enum = $2,
                 error_msg = NULL,
                 processed_at = NOW()
             WHERE id = $1`, [batchRow.id, okStatus]);
          await client.query('COMMIT');
          ok += 1;
        } catch (e) {
          await client.query('ROLLBACK');
          const msg = String(e.message || 'error').slice(0, 500);
          await client.query(`UPDATE import_rows
             SET status_enum = $2,
                 error_msg = $3,
                 processed_at = NOW()
             WHERE id = $1`, [batchRow.id, errorStatus, msg]);
          err += 1;
          errMap.set(msg, (errMap.get(msg) || 0) + 1);
          if (errSamples.length < 5) errSamples.push({
            row: raw,
            error: msg
          });
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(73498,$1)',[jobId]);
      client.release();
    }
    const currentStatusRow = await pool.query(`SELECT
         COUNT(*) FILTER (WHERE status_enum = $2)::int AS pending_count,
         COUNT(*) FILTER (WHERE status_enum = $3)::int AS ok_count,
         COUNT(*) FILTER (WHERE status_enum = $4)::int AS error_count
       FROM import_rows
       WHERE import_job_id = $1`, [jobId, createdStatus, okStatus, errorStatus]);
    const counts = currentStatusRow.rows[0];
    const pendingCount = counts.pending_count || 0;
    const okCount = counts.ok_count || 0;
    const errorCount = counts.error_count || 0;
    const processedCount = okCount + errorCount;
    const isDone = pendingCount === 0;
    let finalStatus = 'PENDING';
    if (isDone) {
      if (okCount === 0 && errorCount > 0) {
        finalStatus = 'FAILED';
      } else if (errorCount > 0) {
        finalStatus = 'PARTIAL';
      } else {
        finalStatus = 'COMPLETE';
      }
    }
    await pool.query(`UPDATE import_jobs
       SET rows_total = $1,
           rows_success = $2,
           rows_error = $3,
           status_enum = $4,
           completed_at = CASE WHEN $4 IN ('COMPLETE','PARTIAL','FAILED') THEN NOW() ELSE completed_at END
       WHERE id = $5`, [job.rows_total || 0, okCount, errorCount, finalStatus, jobId]);
    const error_counts = Array.from(errMap.entries()).map(([message, count]) => ({
      message,
      count
    })).sort((a, b) => b.count - a.count).slice(0, 10);
    res.json({
      done: isDone,
      processed: ok + err,
      ok,
      err,
      totalRows: job.rows_total || 0,
      nextStart: processedCount,
      error_counts,
      errors_sample: errSamples
    });
  } catch (e) {
    res.status(500).json({
      message: e.message || 'Server error'
    });
  }
});
router.post('/:branchId/images/lookup', requireBranchAuth, async (req, res) => {
  const branchId = Number(req.params.branchId);
  const isSuperAdmin = String(req.user?.role || req.user?.role_enum || '').toUpperCase() === 'SUPER_ADMIN';
  if (!Number.isSafeInteger(branchId) || branchId < 1 || (!isSuperAdmin && branchId !== Number(req.user?.branch_id))) return res.status(403).json({ message: 'Forbidden' });
  const input = req.body?.eans;
  if (!Array.isArray(input) || input.length > 1000 || input.some(value => typeof value !== 'string' || value.length > 200)) return res.status(400).json({ message: 'Supply up to 1000 barcode strings' });
  const eans = [...new Set(input.map(value => value.trim()).filter(Boolean))];
  if (!eans.length) return res.json({ found: [] });
  try {
    const { rows } = await pool.query('SELECT DISTINCT b.ean_code FROM barcodes b JOIN branch_variant_stock s ON s.variant_id=b.variant_id WHERE b.ean_code = ANY($1::text[]) AND s.branch_id=$2', [eans,branchId]);
    return res.json({ found: rows.map(row => row.ean_code) });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to look up image barcodes' });
  }
});
router.post('/:branchId/images/confirm', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  const isSuperAdmin = String(req.user?.role || req.user?.role_enum || '').toUpperCase() === 'SUPER_ADMIN';
  if (!isSuperAdmin && (!branchId || branchId !== Number(req.user.branch_id))) return res.status(403).json({
    message: 'Forbidden'
  });
  const images = Array.isArray(req.body?.images) ? req.body.images : [];
  if (!images.length) return res.status(400).json({
    message: 'No images'
  });
  const bodyScope = cleanText(req.body?.scope || req.body?.mode || '').toLowerCase();
  const sharedScopes = new Set(['shared', 'colour', 'color', 'product_colour', 'product_color', 'product-colour', 'product-color']);
  const client = await pool.connect();
  let totalUpdated = 0;
  let sharedUpdated = 0;
  let legacyUpdated = 0;
  let skipped = 0;
  try {
    await client.query('BEGIN');
    for (const img of images) {
      const url = cleanText(img.secure_url || img.image_url || img.url || '');
      if(url && !/^https:\/\//i.test(url)) throw Object.assign(new Error('Image URL must use HTTPS'),{status:400});
      if (!url) {
        skipped += 1;
        continue;
      }
      const rawEan = cleanText(img.ean || img.ean_code || img.filename || img.name || '');
      const explicitEan = cleanText(img.ean || img.ean_code || '');
      const ean = explicitEan || extractEANFromName(rawEan);
      const imageType=cleanText(img.image_type||'front').toLowerCase();
      if(!/^(front|back|side|detail[0-9]*)$/.test(imageType))throw Object.assign(new Error('Invalid image type'),{status:400});
      const imageScope = cleanText(img.scope || img.image_scope || img.mode || bodyScope).toLowerCase();
      const requestedProductId = parseInt(img.product_id, 10);
      const requestedColour = cleanText(img.colour || img.color || '');
      const requestedFit = cleanText(img.fit || '');
      const useShared = img.shared === true || sharedScopes.has(imageScope) || Number.isFinite(requestedProductId) && requestedProductId > 0 && requestedColour;
      if (useShared) {
        let productId = Number.isFinite(requestedProductId) && requestedProductId > 0 ? requestedProductId : null;
        let colour = requestedColour;
        let fit = requestedFit;
        if ((!productId || !colour) && ean) {
          const resolved = await client.query(`SELECT pv.product_id, pv.colour, pv.fit
             FROM barcodes b
             JOIN product_variants pv ON pv.id = b.variant_id
             WHERE b.ean_code = $1
             LIMIT 1`, [ean]);
          if (resolved.rows.length) {
            productId = productId || Number(resolved.rows[0].product_id);
            colour = colour || cleanText(resolved.rows[0].colour);
            if (!fit) fit = cleanText(resolved.rows[0].fit);
          }
        }
        if (!productId || !colour) {
          skipped += 1;
          continue;
        }
        if(!isSuperAdmin && !(await client.query('SELECT 1 FROM product_variants v JOIN branch_variant_stock s ON s.variant_id=v.id WHERE v.product_id=$1 AND s.branch_id=$2 LIMIT 1',[productId,branchId])).rows.length) throw Object.assign(new Error('Product is not stocked in your branch'),{status:403});
        const publicId = cleanText(img.cloudinary_public_id || img.public_id || '') || null;
        await client.query(`INSERT INTO product_colour_images (product_id, colour, fit, image_url, cloudinary_public_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (product_id, (LOWER(BTRIM(colour))), (LOWER(BTRIM(COALESCE(fit, '')))))
           DO UPDATE SET image_url = EXCLUDED.image_url,
                         cloudinary_public_id = COALESCE(EXCLUDED.cloudinary_public_id, product_colour_images.cloudinary_public_id),
                         updated_at = NOW()`, [productId, colour, fit, url, publicId]);
        await client.query(`UPDATE product_variants
           SET image_url = $4
           WHERE product_id = $1
             AND LOWER(BTRIM(colour)) = LOWER(BTRIM($2))
             AND LOWER(BTRIM(COALESCE(fit, ''))) = LOWER(BTRIM($3))`, [productId, colour, fit, url]);
        await client.query(`INSERT INTO product_images (ean_code, image_url, uploaded_at)
           SELECT b.ean_code, $4, NOW()
           FROM product_variants pv
           JOIN barcodes b ON b.variant_id = pv.id
           WHERE pv.product_id = $1
             AND LOWER(BTRIM(pv.colour)) = LOWER(BTRIM($2))
             AND LOWER(BTRIM(COALESCE(pv.fit, ''))) = LOWER(BTRIM($3))
           ON CONFLICT (ean_code,image_type)
           DO UPDATE SET image_url = EXCLUDED.image_url,
                         uploaded_at = NOW()`, [productId, colour, fit, url]);
        sharedUpdated += 1;
        totalUpdated += 1;
        continue;
      }
      if (!ean) {
        skipped += 1;
        continue;
      }
      const barcode = await client.query('SELECT 1 FROM barcodes b JOIN branch_variant_stock s ON s.variant_id=b.variant_id WHERE b.ean_code=$1 AND s.branch_id=$2 LIMIT 1',[ean,branchId]);
      if (!barcode.rows.length) {
        skipped += 1;
        continue;
      }
      await client.query(`INSERT INTO product_images (ean_code, image_url, image_type,uploaded_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (ean_code,image_type)
         DO UPDATE SET image_url = EXCLUDED.image_url,uploaded_at=NOW()`,[ean,url,imageType]);
      if(imageType==='front')await client.query(`UPDATE product_variants v SET image_url=$2 FROM barcodes b WHERE b.variant_id=v.id AND b.ean_code=$1`,[ean,url]);
      legacyUpdated += 1;
      totalUpdated += 1;
    }
    await client.query('COMMIT');
    return res.json({
      totalUpdated,
      sharedUpdated,
      legacyUpdated,
      skipped
    });
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(500).json({
      message: e.message || 'DB error'
    });
  } finally {
    client.release();
  }
});
router.get('/:branchId/stock', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  const isSuperAdmin = String(req.user?.role || req.user?.role_enum || '').toUpperCase() === 'SUPER_ADMIN';
  if (!isSuperAdmin && (!branchId || branchId !== Number(req.user.branch_id))) return res.status(403).json({
    message: 'Forbidden'
  });
  const gender = normGender(req.query.gender || '');
  try {
    const params = [branchId];
    let where = `bvs.branch_id = $1 AND bvs.is_active = TRUE`;
    if (gender) {
      params.push(gender);
      where += ` AND p.gender = $${params.length}`;
    }
    const {
      rows
    } = await pool.query(`SELECT
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
         v.fit,
         v.pack_size,
         v.mrp,
         v.sale_price,
         v.cost_price,
         bvs.on_hand,
         bvs.reserved,
         COALESCE(bc.ean_code,'') AS ean_code,
         COALESCE(NULLIF(pci.image_url, ''), NULLIF(v.image_url, ''), NULLIF(pi.image_url, ''), '') AS image_url
       FROM branch_variant_stock bvs
       JOIN product_variants v ON v.id = bvs.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN product_colour_images pci
         ON pci.product_id = p.id
        AND LOWER(BTRIM(pci.colour)) = LOWER(BTRIM(v.colour))
        AND LOWER(BTRIM(COALESCE(pci.fit, ''))) = LOWER(BTRIM(COALESCE(v.fit, '')))
       LEFT JOIN LATERAL (
         SELECT ean_code FROM barcodes bc WHERE bc.variant_id = v.id ORDER BY id ASC LIMIT 1
       ) bc ON TRUE
       LEFT JOIN product_images pi ON pi.ean_code = bc.ean_code AND pi.image_type='front'
       WHERE ${where}
       ORDER BY p.brand_name, p.name, v.size, v.colour, v.fit`, params);
    res.json(rows);
  } catch {
    res.status(500).json({
      message: 'Server error'
    });
  }
});
router.get('/:branchId/discounts', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  const isSuperAdmin = String(req.user?.role || req.user?.role_enum || '').toUpperCase() === 'SUPER_ADMIN';
  if (!isSuperAdmin && (!branchId || branchId !== Number(req.user.branch_id))) return res.status(403).json({
    message: 'Forbidden'
  });
  try {
    const {
      rows
    } = await pool.query(`SELECT
         COALESCE(
           (
             SELECT v.b2c_discount_pct
             FROM product_variants v
             JOIN branch_variant_stock bvs ON bvs.variant_id = v.id
             WHERE bvs.branch_id = $1
               AND v.b2c_discount_pct IS NOT NULL
             LIMIT 1
           ),
           0
         ) AS b2c_discount_pct,
         COALESCE(
           (
             SELECT v.b2b_discount_pct
             FROM product_variants v
             JOIN branch_variant_stock bvs ON bvs.variant_id = v.id
             WHERE bvs.branch_id = $1
               AND v.b2b_discount_pct IS NOT NULL
             LIMIT 1
           ),
           0
         ) AS b2b_discount_pct`, [branchId]);
    if (!rows.length) {
      return res.json({
        b2c_discount_pct: 0,
        b2b_discount_pct: 0
      });
    }
    res.json(rows[0]);
  } catch {
    res.status(500).json({
      message: 'Server error'
    });
  }
});
router.post('/:branchId/discounts', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10);
  const isSuperAdmin = String(req.user?.role || req.user?.role_enum || '').toUpperCase() === 'SUPER_ADMIN';
  if (!isSuperAdmin && (!branchId || branchId !== Number(req.user.branch_id))) return res.status(403).json({
    message: 'Forbidden'
  });
  if(!isSuperAdmin)return res.status(403).json({message:'Bulk prices affect shared variants. A super admin must apply them.'});
  const b2c = Number(req.body?.b2c_discount_pct);
  const b2b = Number(req.body?.b2b_discount_pct);
  if (!Number.isFinite(b2c) || !Number.isFinite(b2b) || b2c < 0 || b2b < 0 || b2c > 100 || b2b > 100) {
    return res.status(400).json({
      message: 'Invalid discount values'
    });
  }
  try {
    await pool.query(`UPDATE product_variants v
         SET b2c_discount_pct = $2,
             b2b_discount_pct = $3
       FROM branch_variant_stock bvs
       WHERE bvs.variant_id = v.id
         AND bvs.branch_id = $1`, [branchId, b2c, b2b]);
    res.json({
      b2c_discount_pct: b2c,
      b2b_discount_pct: b2b
    });
  } catch {
    res.status(500).json({
      message: 'Server error'
    });
  }
});
module.exports = router;
