const express = require('express')
const jwt = require('jsonwebtoken')
const multer = require('multer')
const pool = require('../db')

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } })

function requireBranchAuth(req, res, next) {
  const hdr = req.headers.authorization || ''
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : ''
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret')
    req.user = payload
    return next()
  } catch {
    return res.status(401).json({ message: 'Unauthorized' })
  }
}

router.get('/:branchId/import-jobs', requireBranchAuth, async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10)
  if (!branchId || branchId !== Number(req.user.branch_id)) return res.status(403).json({ message: 'Forbidden' })
  try {
    const { rows } = await pool.query(
      `SELECT id, file_name, uploaded_by, status_enum, rows_total, rows_success, rows_error, uploaded_at, completed_at, branch_id
       FROM import_jobs
       WHERE branch_id = $1
       ORDER BY id DESC
       LIMIT 100`,
      [branchId]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ message: 'Server error' })
  }
})

router.post('/:branchId/import', requireBranchAuth, upload.single('file'), async (req, res) => {
  const branchId = parseInt(req.params.branchId, 10)
  if (!branchId || branchId !== Number(req.user.branch_id)) return res.status(403).json({ message: 'Forbidden' })
  if (!req.file) return res.status(400).json({ message: 'File required' })
  try {
    const fileName = req.file.originalname || `upload_${Date.now()}.bin`
    const { rows } = await pool.query(
      `INSERT INTO import_jobs (file_name, uploaded_by, status_enum, rows_total, rows_success, rows_error, branch_id)
       VALUES ($1, $2, 'PENDING', 0, 0, 0, $3)
       RETURNING id, file_name, uploaded_by, status_enum, rows_total, rows_success, rows_error, uploaded_at, completed_at, branch_id`,
      [fileName, req.user.id, branchId]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    res.status(500).json({ message: 'Server error' })
  }
})

module.exports = router
