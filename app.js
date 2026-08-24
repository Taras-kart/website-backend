require('dotenv').config()

const express = require('express')
const cors = require('cors')
const pool = require('./db')
const shiprocketPublicRoutes = require('./routes/shiprocketPublicRoutes')
const createCategoryRoutes = require('./routes/categoryRoutes')

const app = express()

app.set('etag', false)

const defaultOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
  'https://taras-kart-shopping-mall.vercel.app',
  'https://website-super-admin.vercel.app',
  'https://taras-kart-admin.vercel.app',
  'https://www.taraskart.com',
  'https://taraskart.com',
  'https://www.attach.co.in',
  'https://attach.co.in'
]

const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean)

const allowedOrigins = envOrigins.length ? envOrigins : defaultOrigins

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true)

    const normalizedOrigin = origin.replace(/\/+$/, '')

    if (allowedOrigins.includes('*')) {
      return callback(null, true)
    }

    if (allowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true)
    }

    return callback(null, false)
  },
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['authorization', 'content-type'],
  credentials: true,
  optionsSuccessStatus: 204
}

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  res.set('Pragma', 'no-cache')
  res.set('Expires', '0')
  next()
})

app.use(cors(corsOptions))
app.options('*', cors(corsOptions))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    req.body = {}
    return next()
  }

  return next(err)
})

app.use('/api', shiprocketPublicRoutes)
app.use('/api/upload', require('./routes/uploadRoutes'))
app.use('/api/products', require('./routes/productRoutes'))
app.use('/api/categories', createCategoryRoutes(pool))
app.use('/api/b2b-customers', require('./routes/b2bCustomerRoutes'))
app.use('/api/b2c-customers', require('./routes/b2cCustomerRoutes'))
app.use('/api/signup', require('./routes/b2cCustomerRoutes'))
app.use('/api/auth', require('./routes/authRoutes'))
app.use('/api/wishlist', require('./routes/wishlistRoutes'))
app.use('/api/cart', require('./routes/cartRoutes'))
app.use('/api/user', require('./routes/userRoutes'))
app.use('/api/orders', require('./routes/orderRoutes'))
app.use('/api/auth-branch', require('./routes/authBranchRoutes'))
app.use('/api/barcodes', require('./routes/barcodeRoutes'))
app.use('/api/branch', require('./routes/branchInventoryRoutes'))
app.use('/api/inventory', require('./routes/inventoryRoutes'))
app.use('/api/sales', require('./routes/salesRoutes'))
app.use('/api/sales', require('./routes/posRoutes'))
app.use('/api', require('./routes/shiprocketRoutes'))
app.use('/api', require('./routes/shipmentRoutes'))
app.use('/api', require('./routes/returnsRoutes'))
app.use('/api/razorpay', require('./routes/razorpayRoutes'))
app.use('/api/homepage-images', require('./routes/homepageImageRoutes'))
app.use('/api/coins', require('./routes/coinsRoutes'))
app.use('/api/b2b', require('./routes/b2bRoutes'))
app.use('/api/b2b', require('./routes/b2bImportRoutes'))

app.get('/', (req, res) => {
  res.status(200).send('Taras Kart API')
})

app.get('/healthz', (req, res) => {
  res.status(200).send('ok')
})

app.get('/api/debug/blob-env', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).send('Not found')
  }

  return res.json({
    hasToken: Boolean(
      process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.VERCEL_BLOB_READ_WRITE_TOKEN ||
      process.env.VERCEL_BLOB_RW_TOKEN
    )
  })
})

app.get('/api/debug/jwt', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).send('Not found')
  }

  return res.json({
    jwtSecretPresent: Boolean(process.env.JWT_SECRET)
  })
})

app.get('/api/debug/db', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).send('Not found')
  }

  try {
    const connectionResult = await pool.query('SELECT 1 AS ok')
    const usersResult = await pool.query(
      'SELECT COUNT(*)::int AS n FROM users'
    )

    return res.json({
      dbOk: connectionResult.rows[0].ok === 1,
      usersCount: usersResult.rows[0].n
    })
  } catch (error) {
    return res.status(500).json({
      dbOk: false,
      error: String(error?.message || error)
    })
  }
})

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err)
  }

  return res.status(err.status || 500).json({
    message: err.message || 'Internal server error'
  })
})

app.use((req, res) => {
  res.status(404).send('Not found')
})

module.exports = app