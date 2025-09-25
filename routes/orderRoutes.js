// routes/orderRoutes.js
const router = require('express').Router();
const { getMyOrders, getTracking } = require('../controllers/orderController');

// /api/orders?email=...&phone=...
router.get('/', getMyOrders);

// /api/orders/track/:orderId (optional :channelId)
router.get('/track/:orderId/:channelId?', getTracking);

module.exports = router;
