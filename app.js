const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : '*',
  credentials: true
}));

app.use(express.json());

app.use('/upload', require('./routes/uploadRoutes'));
app.use('/products', require('./routes/productRoutes'));
app.use('/b2b-customers', require('./routes/b2bCustomerRoutes'));
app.use('/b2c-customers', require('./routes/b2cCustomerRoutes'));
app.use('/signup', require('./routes/b2cCustomerRoutes'));
app.use('/auth', require('./routes/authRoutes'));
app.use('/wishlist', require('./routes/wishlistRoutes'));
app.use('/cart', require('./routes/cartRoutes'));
app.use('/user', require('./routes/userRoutes'));

app.get('/healthz', (req, res) => res.status(200).send('ok'));

module.exports = app;
