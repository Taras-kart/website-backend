require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

const defaultOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'https://taras-kart-shopping-mall.vercel.app',
  'https://taras-kart-admin.vercel.app'
];
const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const allowedOrigins = envOrigins.length ? envOrigins : defaultOrigins;

const corsOptions = {
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes('*')) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  allowedHeaders: ['authorization', 'content-type'],
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json());

app.use('/api/upload', require('./routes/uploadRoutes'));
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/b2b-customers', require('./routes/b2bCustomerRoutes'));
app.use('/api/b2c-customers', require('./routes/b2cCustomerRoutes'));
app.use('/api/signup', require('./routes/b2cCustomerRoutes'));
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/wishlist', require('./routes/wishlistRoutes'));
app.use('/api/cart', require('./routes/cartRoutes'));
app.use('/api/user', require('./routes/userRoutes'));
app.use('/api/orders', require('./routes/orderRoutes'));
app.use('/api/auth-branch', require('./routes/authBranchRoutes'));
app.use('/api/barcodes', require('./routes/barcodeRoutes'));
app.use('/api/branch', require('./routes/branchInventoryRoutes'));
app.use('/api/inventory', require('./routes/inventoryRoutes'));
app.use('/api/sales', require('./routes/salesRoutes'));

app.get('/', (req, res) => res.status(200).send('Taras Kart API'));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.get('/api/debug/blob-env', (req, res) => {
  res.json({
    hasToken: Boolean(
      process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.VERCEL_BLOB_READ_WRITE_TOKEN ||
      process.env.VERCEL_BLOB_RW_TOKEN
    )
  });
});

app.use((req, res) => res.status(404).send('Not found'));

app.get('/api/debug/jwt', (req, res) => {
  res.json({ jwtSecretPresent: Boolean(process.env.JWT_SECRET) });
});

app.get('/api/debug/db', async (req, res) => {
  const pool = require('./db');
  try {
    const r1 = await pool.query('SELECT 1 as ok');
    const r2 = await pool.query('SELECT COUNT(*)::int AS n FROM users');
    res.json({ dbOk: r1.rows[0].ok === 1, usersCount: r2.rows[0].n });
  } catch (e) {
    res.status(500).json({ dbOk: false, error: String(e && e.message || e) });
  }
});


module.exports = app;
