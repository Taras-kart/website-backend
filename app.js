require('dotenv').config()

const express = require('express')
const cors = require('cors')
const pool = require('./db')
const shiprocketPublicRoutes = require('./routes/shiprocketPublicRoutes')

const app = express()

app.set('etag', 'weak')
app.disable('x-powered-by')

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
    if (allowedOrigins.includes('*') || allowedOrigins.includes(normalizedOrigin)) return callback(null, true)
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

app.use(require('compression')())
app.use(cors(corsOptions))
app.options('*', cors(corsOptions))
app.use(express.json({ limit: '10mb', verify: (req,res,buffer) => { req.rawBody=buffer } }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Invalid JSON request body' })
  }
  return next(err)
})

app.use('/api', require('./middleware/accessGateway'))
app.use('/api', require('./middleware/customerGateway'))
app.use('/api', shiprocketPublicRoutes)
app.use('/api/upload', require('./routes/uploadRoutes'))
app.use('/api/products', require('./routes/catalogueRoutes'))
app.use('/api/products', require('./routes/productRoutes'))
app.use('/api/manage', require('./routes/managementRoutes'))
app.use('/api/categories', require('./routes/categoryRoutes'))
app.use('/api/b2b-customers', require('./routes/b2bCustomerRoutes'))
app.use('/api/b2c-customers', require('./routes/b2cCustomerRoutes'))
app.use('/api/signup', require('./routes/b2cCustomerRoutes'))
app.use('/api/auth', require('./routes/authRoutes'))
app.use('/api/wishlist', require('./routes/wishlistRoutes'))
app.use('/api/cart', require('./routes/cartRoutes'))
app.use('/api/user', require('./routes/userRoutes'))
app.use('/api/orders', require('./routes/checkoutRoutes'))
app.use('/api/orders', require('./routes/orderRoutes'))
app.use('/api/auth-branch', require('./routes/authBranchRoutes'))
app.use('/api/barcodes', require('./routes/barcodeRoutes'))
app.use('/api/branch', require('./routes/branchInventoryRoutes'))
app.use('/api/inventory', require('./routes/inventoryRoutes'))
app.use('/api/sales', require('./routes/checkoutRoutes'))
app.use('/api/sales', require('./routes/wholesaleCheckoutRoutes'))
app.use('/api/sales', require('./routes/wholesaleManagementRoutes'))
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

app.get('/', (req, res) => res.status(200).send('Taras Kart API'))
app.get('/healthz', (req, res) => res.status(200).send('ok'))
app.get('/api/branches', async (req,res,next) => { try { res.json((await pool.query('SELECT id,name,city FROM branches WHERE is_active=TRUE ORDER BY name')).rows) } catch(error) { next(error) } })

app.get('/api/health', async (req, res) => { try { await pool.query('SELECT 1'); res.json({ ok: true }) } catch { res.status(503).json({ ok: false, message: 'Database unavailable' }) } })

app.get('/api/debug/blob-env', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).send('Not found')
  return res.json({
    hasToken: Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_READ_WRITE_TOKEN || process.env.VERCEL_BLOB_RW_TOKEN)
  })
})

app.get('/api/debug/jwt', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).send('Not found')
  return res.json({ jwtSecretPresent: Boolean(process.env.JWT_SECRET) })
})

app.get('/api/debug/db', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).send('Not found')
  try {
    const connectionResult = await pool.query('SELECT 1 AS ok')
    const usersResult = await pool.query('SELECT COUNT(*)::int AS n FROM users')
    return res.json({ dbOk: connectionResult.rows[0].ok === 1, usersCount: usersResult.rows[0].n })
  } catch (error) {
    return res.status(500).json({ dbOk: false, error: String(error?.message || error) })
  }
})

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  const status = err.status || (err.code === '23505' ? 409 : err.code === '23503' ? 409 : 500)
  if (status >= 500) console.error('API error:', err.code || err.name, err.message)
  return res.status(status).json({ message: status < 500 || err.status === 503 ? err.message : 'Unable to complete this request. Please try again.' })
})

app.use((req, res) => res.status(404).send('Not found'))

module.exports = app
