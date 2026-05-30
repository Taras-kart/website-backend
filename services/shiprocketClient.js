// services/shiprocketClient.js
const Shiprocket = require('./shiprocketService');
const pool = require('../db');

// Create one shared brain
const sharedShiprocket = new Shiprocket({ pool });

// Directly call the methods - the internal API() call 
// will handle the token refresh automatically.
exports.listOrders = (page = 1) => sharedShiprocket.listOrders(page);

exports.trackByOrderId = (orderId, channelId) => sharedShiprocket.trackOrder(orderId, channelId);