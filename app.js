const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : '*',
  credentials: true
}));

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

app.get('/', (req, res) => res.status(200).send('Taras Kart API'));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.use((req, res) => res.status(404).send('Not found'));


app.get('/api/debug/blob-env', (req, res) => {
  res.json({
    hasToken: Boolean(
      process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.VERCEL_BLOB_READ_WRITE_TOKEN ||
      process.env.VERCEL_BLOB_RW_TOKEN
    )
  });
});


module.exports = app;
