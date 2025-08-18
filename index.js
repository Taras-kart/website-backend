const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Serve uploads folder as static (absolute path ensures no broken images)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Routes
app.use('/api/upload', require('./routes/uploadRoutes')); // Ensure /api/upload is specific
app.use('/api/products', require('./routes/productRoutes'));
app.use('/api/b2b-customers', require('./routes/b2bCustomerRoutes'));
app.use('/api/b2c-customers', require('./routes/b2cCustomerRoutes'));
app.use('/api/signup', require('./routes/b2cCustomerRoutes')); // Make sure the route is correctly wired
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/wishlist', require('./routes/wishlistRoutes'));
app.use('/api/cart', require('./routes/cartRoutes'));
app.use('/api/user', require('./routes/userRoutes'));

// Start server
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
