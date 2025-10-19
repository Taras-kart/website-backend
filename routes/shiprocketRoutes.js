const express = require('express');
const pool = require('../db');
const Shiprocket = require('../services/shiprocketService');
const { fulfillOrderWithShiprocket } = require('../services/orderFulfillment');

const router = express.Router();

router.post('/shiprocket/warehouses/sync', async (req, res) => {
  try {
    const sr = new Shiprocket({ pool });
    await sr.init();
    const { rows: branches } = await pool.query(
      'SELECT id, name, address, city, state, pincode, phone, email FROM branches WHERE is_active = true'
    );
    const results = [];
    for (const b of branches) {
      const data = await sr.upsertWarehouseFromBranch(b);
      const pickupName = data?.pickup_location || b.name;
      await pool.query(
        `INSERT INTO shiprocket_warehouses (branch_id, warehouse_id, name, pincode, city, state, address, phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (branch_id) DO UPDATE SET warehouse_id=EXCLUDED.warehouse_id, name=EXCLUDED.name, pincode=EXCLUDED.pincode, city=EXCLUDED.city, state=EXCLUDED.state, address=EXCLUDED.address, phone=EXCLUDED.phone`,
        [b.id, data?.pickup_id || 0, pickupName, b.pincode, b.city, b.state, b.address, b.phone]
      );
      results.push({ branch_id: b.id, pickup: pickupName });
    }
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || 'sync failed' });
  }
});

router.post('/shiprocket/fulfill/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const saleRes = await pool.query('SELECT * FROM sales WHERE id=$1', [id]);
    if (!saleRes.rows.length) return res.status(404).json({ message: 'Sale not found' });
    const sale = saleRes.rows[0];
    const items = (await pool.query('SELECT * FROM sale_items WHERE sale_id=$1', [id])).rows;
    sale.items = items;
    const shipments = await fulfillOrderWithShiprocket(sale, pool);
    res.json({ ok: true, shipments });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || 'fulfillment failed' });
  }
});

router.post('/shiprocket/webhook', async (req, res) => {
  try {
    const payload = req.body || {};
    const shipmentId = payload?.shipment_id || payload?.data?.shipment_id || null;
    const status = payload?.current_status || payload?.data?.current_status || null;
    if (shipmentId && status) {
      await pool.query('UPDATE shipments SET status=$1 WHERE shiprocket_shipment_id=$2', [status, shipmentId]);
    }
    res.json({ ok: true });
  } catch {
    res.status(200).json({ ok: true });
  }
});

module.exports = router;
