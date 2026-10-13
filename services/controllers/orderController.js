const { trackByOrderId } = require('../services/shiprocketClient');
const pool = require('../db');

exports.getMyOrders = async (req, res) => {
  try {
    const { email, phone } = req.query;

    if (!email && !phone) return res.json({ count: 0, items: [] });

    // Query local PostgreSQL instead of Shiprocket
    const { rows } = await pool.query(
      `SELECT * FROM sales 
       WHERE LOWER(customer_email) = LOWER($1) 
          OR customer_mobile = $2 
       ORDER BY created_at DESC`,
      [email || '', phone || '']
    );

    const formattedOrders = rows.map(o => ({
      id: o.id,
      name: `Order #${String(o.id).slice(0, 8)}`,
      brand: 'Taras Kart',
      image: '/images/placeholder.jpg', // Safe fallback image
      offerPrice: Number(o.total || (o.totals && o.totals.payable) || 0),
      date: o.created_at ? new Date(o.created_at).toLocaleDateString('en-IN') : '',
      status: o.status || 'PLACED'
    }));

    res.json({ count: formattedOrders.length, items: formattedOrders });
  } catch (err) {
    console.error('getMyOrders error', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
};

exports.getTracking = async (req, res) => {
  try {
    const { orderId, channelId } = req.params;
    const data = await trackByOrderId(orderId, channelId);
    res.json(data);
  } catch (err) {
    console.error('getTracking error', err?.response?.data || err);
    res.status(500).json({ error: 'Failed to fetch tracking' });
  }
};