const express = require('express');
const pool = require('../db');
const Shiprocket = require('../services/shiprocketService');
const { fulfillOrderWithShiprocket } = require('../services/orderFulfillment');

const router = express.Router();
const { sendOrderShipped, sendOrderDelivered } = require('../services/whatsapp');
const { creditEarnedCoins } = require('../services/coinsService');

router.get('/shiprocket/warehouses', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, branch_id, warehouse_id, name, pincode, city, state, address, phone, created_at, updated_at FROM shiprocket_warehouses ORDER BY id ASC'
    );
    res.json(rows);
  } catch {
    res.status(500).json({ ok: false, message: 'Failed to fetch warehouses' });
  }
});

router.post('/shiprocket/warehouses/import', async (req, res) => {
  try {
    const sr = new Shiprocket({ pool });
    await sr.init();
    const { data } = await sr.api('get', '/settings/company/pickup');
    const pickups = Array.isArray(data?.data?.shipping_address) ? data.data.shipping_address : [];
    const { rows: branches } = await pool.query('SELECT id, name, address, city, state, pincode, phone FROM branches WHERE is_active = true');
    const norm = (s) => String(s ?? '').trim().toLowerCase();
    const results = [];
    for (const b of branches) {
      const bpincode = String(b.pincode || '').trim();
      let best = null;
      if (bpincode) best = pickups.find((p) => String(p.pin_code || '').trim() === bpincode);
      if (!best && b.city) {
        const cityNorm = norm(b.city);
        best = pickups.find((p) => norm(p.city) === cityNorm);
      }
      if (!best) {
        results.push({ branch_id: b.id, error: 'No matching pickup found in Shiprocket' });
        continue;
      }
      const pickupName = best.pickup_location || best.name || b.name;
      const pickupId = best.pickup_id || best.id || best.rto_address_id || 0;
      await pool.query(
        `INSERT INTO shiprocket_warehouses (branch_id, warehouse_id, name, pincode, city, state, address, phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (branch_id) DO UPDATE
         SET warehouse_id=EXCLUDED.warehouse_id,
             name=EXCLUDED.name,
             pincode=EXCLUDED.pincode,
             city=EXCLUDED.city,
             state=EXCLUDED.state,
             address=EXCLUDED.address,
             phone=EXCLUDED.phone`,
        [
          b.id,
          pickupId,
          pickupName,
          String(best.pin_code || b.pincode || ''),
          best.city || b.city || '',
          best.state || b.state || '',
          best.address || b.address || '',
          b.phone || ''
        ]
      );
      results.push({ branch_id: b.id, mapped_to: pickupName, pickup_id: pickupId });
    }
    res.json({ ok: true, results });
  } catch (e) {
    const msg = e.response?.data || e.message || 'import failed';
    res.status(500).json({ ok: false, message: msg });
  }
});

router.post('/shiprocket/warehouses/sync', async (req, res) => {
  try {
    const sr = new Shiprocket({ pool });
    await sr.init();
    const { rows: branches } = await pool.query('SELECT id, name, address, city, state, pincode, phone, email FROM branches WHERE is_active = true');
    const results = [];
    for (const b of branches) {
      try {
        const data = await sr.upsertWarehouseFromBranch(b);
        const pickupName = data?.pickup_location || `${b.name} - ${b.pincode}`;
        await pool.query(
          `INSERT INTO shiprocket_warehouses (branch_id, warehouse_id, name, pincode, city, state, address, phone)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (branch_id) DO UPDATE 
           SET warehouse_id=EXCLUDED.warehouse_id, name=EXCLUDED.name, pincode=EXCLUDED.pincode, 
               city=EXCLUDED.city, state=EXCLUDED.state, address=EXCLUDED.address, phone=EXCLUDED.phone`,
          [b.id, data?.pickup_id || 0, pickupName, b.pincode, b.city, b.state, b.address, b.phone]
        );
        results.push({ branch_id: b.id, pickup: pickupName });
      } catch (innerErr) {
        results.push({ branch_id: b.id, error: innerErr.response?.data || innerErr.message });
      }
    }
    res.json({ ok: true, results });
  } catch (e) {
    const errData = e.response?.data || e.message || 'sync failed';
    res.status(500).json({ ok: false, message: errData });
  }
});

router.post('/shiprocket/fulfill/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const saleRes = await pool.query('SELECT * FROM sales WHERE id=$1', [id]);
    if (!saleRes.rows.length) return res.status(404).json({ ok: false, message: 'Sale not found' });
    const sale = saleRes.rows[0];
    const items = (await pool.query('SELECT * FROM sale_items WHERE sale_id=$1', [id])).rows;
    sale.items = items;
    const shipments = await fulfillOrderWithShiprocket(sale, pool);
    res.json({ ok: true, shipments });
  } catch (e) {
    const errData = e.response?.data || e.message || 'fulfillment failed';
    res.status(500).json({ ok: false, message: errData });
  }
});

// Shiprocket's dashboard performs a reachability check (GET/HEAD) before
// allowing the webhook URL to be saved. Respond 200 to keep that check happy —
// actual tracking updates always arrive via POST, handled below.
//
// NOTE: Shiprocket blocks webhook URLs containing the words "shiprocket",
// "kartrocket", "sr", or "kr". Use /api/logistics/webhook (below) when
// registering the URL in their dashboard — /api/shiprocket/webhook is kept
// for backward compatibility only and should not be used with Shiprocket.
router.get(['/shiprocket/webhook', '/logistics/webhook'], (req, res) => {
  res.status(200).json({ ok: true });
});

router.head(['/shiprocket/webhook', '/logistics/webhook'], (req, res) => {
  res.status(200).end();
});

router.post(['/shiprocket/webhook', '/logistics/webhook'], async (req, res) => {
  try {
    const payload = req.body || {};

    // Real Shiprocket payload uses awb, current_status/shipment_status,
    // and channel_order_id (which is the value WE sent when creating the
    // shipment — "${sale.id}-${branch_id}"). There is no shipment_id field.
    const awbCode = payload?.awb ? String(payload.awb) : null;
    const trackingUrl = payload?.tracking_url || payload?.track_url || null;
    const status = String(
      payload?.current_status || payload?.shipment_status || ''
    ).trim();
    const channelOrderId = String(
      payload?.channel_order_id || payload?.order_id || ''
    ).trim();

    if (!channelOrderId || !status) {
      return res.json({ ok: true });
    }

    // channel_order_id is formatted as "${sale.id}-${branch_id}" —
    // extract the sale UUID (everything before the last "-<digits>")
    const match = channelOrderId.match(/^(.+)-(\d+)$/);
    const saleId = match ? match[1] : channelOrderId;

    // Update shipment status in DB (best-effort — match by awb or shipment id)
    if (awbCode) {
      await pool.query(
        'UPDATE shipments SET status=$1 WHERE awb=$2 OR shiprocket_shipment_id=$2',
        [status, awbCode]
      ).catch(() => {});
    }

    // Fetch sale details for WhatsApp messaging
    const saleRow = await pool.query(
      'SELECT customer_name, customer_mobile, customer_email, total, totals, id FROM sales WHERE id=$1::uuid LIMIT 1',
      [saleId]
    ).catch(() => ({ rowCount: 0 }));

    if (!saleRow.rowCount) {
      return res.json({ ok: true });
    }

    const sale = saleRow.rows[0];
    const mobile = sale.customer_mobile;
    const customerName = sale.customer_name || 'Customer';
    const orderId = String(sale.id).slice(0, 8).toUpperCase();

    const statusUpper = status.toUpperCase();

    // Message 2 — AWB assigned / shipped
    const isShipped = statusUpper.includes('SHIPPED') ||
                      statusUpper.includes('PICKED') ||
                      statusUpper.includes('AWB') ||
                      statusUpper.includes('IN TRANSIT');

    if (isShipped && mobile && awbCode) {
      const trackLink = trackingUrl ||
        `https://shiprocket.co/tracking/${awbCode}`;
      await sendOrderShipped(mobile, {
        customerName,
        orderId,
        awbNumber: awbCode,
        trackingUrl: trackLink
      }).catch(err => console.error('WhatsApp order_shipped failed:', err.message));
    }

    // Message 3 — Delivered + credit earned coins
    const isDelivered = statusUpper.includes('DELIVERED');
    if (isDelivered) {
      if (mobile) {
        await sendOrderDelivered(mobile, {
          customerName,
          orderId
        }).catch(err => console.error('WhatsApp order_delivered failed:', err.message));
      }

      // Credit earned coins — find user by sale's customer_email
      try {
        const email = sale.customer_email
        const subtotal = sale.totals?.bagTotal
          ? Number(sale.totals.bagTotal) - Number(sale.totals.discountTotal || 0)
          : Number(sale.total || 0)

        if (email && subtotal > 0) {
          const userRow = await pool.query(
            'SELECT id FROM userstaras WHERE LOWER(email)=LOWER($1) LIMIT 1',
            [email]
          )
          if (userRow.rows[0]?.id) {
            await creditEarnedCoins(userRow.rows[0].id, saleId, subtotal)
              .catch(e => console.error('Coins creditEarned error:', e.message))
          }
        }
      } catch (coinErr) {
        console.error('Coins: error looking up sale for credit:', coinErr.message)
      }
    }

    return res.json({ ok: true });

  } catch (err) {
    console.error('Shiprocket webhook processing error:', err.message);
    // Still return 200 so Shiprocket doesn't retry/disable the endpoint
    if (!res.headersSent) return res.json({ ok: true });
  }
});

async function computeServiceabilityForSaleId(saleId) {
  const saleRes = await pool.query('SELECT * FROM sales WHERE id=$1', [saleId]);
  if (!saleRes.rows.length) return { error: { code: 404, body: { ok: false, message: 'Sale not found' } } };
  const sale = saleRes.rows[0];

  const deliveryPin = String(sale?.shipping_address?.pincode || sale?.pincode || '').trim();
  if (!deliveryPin || deliveryPin.length !== 6) {
    return { error: { code: 400, body: { ok: false, message: 'Invalid delivery pincode' } } };
  }

  let pickupPin = '';
  if (sale?.branch_id) {
    const br = await pool.query('SELECT pincode FROM branches WHERE id=$1 LIMIT 1', [sale.branch_id]);
    pickupPin = String(br.rows[0]?.pincode || '').trim();
  }

  if (!pickupPin) {
    const { rows } = await pool.query('SELECT pincode FROM branches WHERE is_active = true AND pincode IS NOT NULL LIMIT 1');
    pickupPin = String(rows[0]?.pincode || '').trim();
  }

  if (!pickupPin || pickupPin.length !== 6) {
    return { error: { code: 500, body: { ok: false, message: 'No pickup pincode configured' } } };
  }

  const payable = typeof sale.totals === 'object' && sale.totals !== null ? Number(sale.totals.payable || 0) : Number(sale.total || 0);
  const cod = String(sale.payment_status || '').toUpperCase() === 'COD' && payable > 0;

  const sr = new Shiprocket({ pool });
  await sr.init();

  const data = await sr.checkServiceability({
    pickup_postcode: pickupPin,
    delivery_postcode: deliveryPin,
    cod,
    weight: 0.5
  });

  return { data, meta: { pickup_postcode: pickupPin, delivery_postcode: deliveryPin, cod, weight: 0.5 } };
}

async function getShipmentsForSale(saleId) {
  const { rows } = await pool.query('SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at DESC', [saleId]);
  if (!rows.length) return { error: { code: 404, body: { ok: false, message: 'No shipments found for this sale' } } };
  const shipmentIds = rows.map((r) => r.shiprocket_shipment_id).filter((v) => v != null);
  if (!shipmentIds.length) return { error: { code: 404, body: { ok: false, message: 'No Shiprocket shipment ids found' } } };
  return { rows, shipmentIds };
}

async function getLatestShiprocketOrderIdForSale(saleId) {
  const { rows } = await pool.query('SELECT shiprocket_order_id FROM shipments WHERE sale_id=$1 AND shiprocket_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 1', [saleId]);
  const orderId = rows?.[0]?.shiprocket_order_id || null;
  if (!orderId) return { error: { code: 404, body: { ok: false, message: 'Shiprocket order id not found for this sale' } } };
  return { orderId };
}

router.get('/shiprocket/serviceability/:saleId', async (req, res) => {
  try {
    const out = await computeServiceabilityForSaleId(req.params.saleId);
    if (out.error) return res.status(out.error.code).json(out.error.body);
    res.json({ ok: true, ...out.meta, ...out.data });
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch serviceability';
    res.status(500).json({ ok: false, message: msg });
  }
});

router.get('/shiprocket/serviceability/by-sale/:saleId', async (req, res) => {
  try {
    const out = await computeServiceabilityForSaleId(req.params.saleId);
    if (out.error) return res.status(out.error.code).json(out.error.body);
    res.json({ ok: true, ...out.meta, ...out.data });
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch serviceability';
    res.status(500).json({ ok: false, message: msg });
  }
});

router.get('/shiprocket/serviceability/sale/:saleId', async (req, res) => {
  try {
    const out = await computeServiceabilityForSaleId(req.params.saleId);
    if (out.error) return res.status(out.error.code).json(out.error.body);
    res.json({ ok: true, ...out.meta, ...out.data });
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch serviceability';
    res.status(500).json({ ok: false, message: msg });
  }
});

router.get('/shiprocket/pincode', async (req, res) => {
  try {
    const deliveryPin = String(req.query.pincode || '').trim();
    if (!deliveryPin || deliveryPin.length !== 6) return res.status(400).json({ ok: false, message: 'Invalid pincode' });

    const { rows } = await pool.query('SELECT pincode FROM branches WHERE is_active = true AND pincode IS NOT NULL LIMIT 1');
    const pickupPin = String(rows[0]?.pincode || '').trim();
    if (!pickupPin) return res.status(500).json({ ok: false, message: 'No pickup pincode configured' });

    const sr = new Shiprocket({ pool });
    await sr.init();

    const data = await sr.checkServiceability({
      pickup_postcode: pickupPin,
      delivery_postcode: deliveryPin,
      cod: true,
      weight: 0.5
    });

    const list = Array.isArray(data?.data?.available_courier_companies) ? data.data.available_courier_companies : [];
    const serviceable = list.length > 0;

    return res.json({
      ok: true,
      serviceable,
      est_delivery: list[0]?.etd || null,
      cod_available: list.some((c) => Number(c.cod) === 1)
    });
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to check pincode';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.post('/shiprocket/assign-courier/by-sale/:saleId', async (req, res) => {
  try {
    const courier_company_id = Number(req.body?.courier_company_id || 0);
    if (!courier_company_id) return res.status(400).json({ ok: false, message: 'courier_company_id is required' });

    const out = await getShipmentsForSale(req.params.saleId);
    if (out.error) return res.status(out.error.code).json(out.error.body);

    const sr = new Shiprocket({ pool });
    await sr.init();

    const { data } = await sr.api('post', '/courier/assign/awb', {
      shipment_id: out.shipmentIds,
      courier_company_id
    });

    const statusCode = Number(data?.status_code || 0);
    const awbAssignStatus = data?.awb_assign_status != null ? Number(data.awb_assign_status) : null;
    const message = data?.message || '';
    const srErr = data?.response?.data?.awb_assign_error || '';

    const walletLow = statusCode === 350 || /recharge/i.test(message) || /recharge/i.test(srErr);
    const success = awbAssignStatus === 1 || statusCode === 200;

    if (walletLow || !success) {
      return res.status(400).json({ ok: false, message: srErr || message || 'Unable to assign courier / generate AWB', data });
    }

    return res.json({ ok: true, data });
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to assign courier';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.post('/shiprocket/assign-courier', async (req, res) => {
  try {
    const saleId = String(req.body?.saleId || req.body?.sale_id || '').trim();
    const courier_company_id = Number(req.body?.courier_company_id || 0);

    if (!saleId) return res.status(400).json({ ok: false, message: 'saleId is required' });
    if (!courier_company_id) return res.status(400).json({ ok: false, message: 'courier_company_id is required' });

    const out = await getShipmentsForSale(saleId);
    if (out.error) return res.status(out.error.code).json(out.error.body);

    const sr = new Shiprocket({ pool });
    await sr.init();

    const { data } = await sr.api('post', '/courier/assign/awb', {
      shipment_id: out.shipmentIds,
      courier_company_id
    });

    const statusCode = Number(data?.status_code || 0);
    const awbAssignStatus = data?.awb_assign_status != null ? Number(data.awb_assign_status) : null;
    const message = data?.message || '';
    const srErr = data?.response?.data?.awb_assign_error || '';

    const walletLow = statusCode === 350 || /recharge/i.test(message) || /recharge/i.test(srErr);
    const success = awbAssignStatus === 1 || statusCode === 200;

    if (walletLow || !success) {
      return res.status(400).json({ ok: false, message: srErr || message || 'Unable to assign courier / generate AWB', data });
    }

    return res.json({ ok: true, data });
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to assign courier';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.post('/shiprocket/assign-awb/by-sale/:saleId', async (req, res) => {
  try {
    const out = await getShipmentsForSale(req.params.saleId);
    if (out.error) return res.status(out.error.code).json(out.error.body);

    const sr = new Shiprocket({ pool });
    await sr.init();

    const result = await sr.assignAWBAndLabel({ shipment_id: out.shipmentIds });

    const statusCode = Number(result?.status_code || result?.data?.status_code || 0);
    const message = result?.message || result?.data?.message || '';
    const srErr = result?.response?.data?.awb_assign_error || result?.data?.response?.data?.awb_assign_error || '';

    const walletLow = statusCode === 350 || /recharge/i.test(message) || /recharge/i.test(srErr);

    if (walletLow || statusCode !== 200) {
      return res.status(400).json({ ok: false, message: srErr || message || 'Unable to generate AWB', result });
    }

    return res.json({ ok: true, result });
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to assign AWB';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.post('/shiprocket/assign-awb', async (req, res) => {
  try {
    const saleId = String(req.body?.saleId || req.body?.sale_id || '').trim();
    if (!saleId) return res.status(400).json({ ok: false, message: 'saleId is required' });

    const out = await getShipmentsForSale(saleId);
    if (out.error) return res.status(out.error.code).json(out.error.body);

    const sr = new Shiprocket({ pool });
    await sr.init();

    const result = await sr.assignAWBAndLabel({ shipment_id: out.shipmentIds });

    const statusCode = Number(result?.status_code || result?.data?.status_code || 0);
    const message = result?.message || result?.data?.message || '';
    const srErr = result?.response?.data?.awb_assign_error || result?.data?.response?.data?.awb_assign_error || '';

    const walletLow = statusCode === 350 || /recharge/i.test(message) || /recharge/i.test(srErr);

    if (walletLow || statusCode !== 200) {
      return res.status(400).json({ ok: false, message: srErr || message || 'Unable to generate AWB', result });
    }

    return res.json({ ok: true, result });
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to assign AWB';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.get('/shiprocket/tracking/by-sale/:saleId', async (req, res) => {
  try {
    const out = await getLatestShiprocketOrderIdForSale(req.params.saleId);
    if (out.error) return res.status(out.error.code).json(out.error.body);

    const sr = new Shiprocket({ pool });
    await sr.init();

    const orderId = out.orderId;
    const { data } = await sr.api('get', `/courier/track?order_id=${encodeURIComponent(String(orderId))}`);

    return res.json({ ok: true, data });
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch tracking';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.get('/shiprocket/label/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId;
    const { rows } = await pool.query('SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at DESC', [saleId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: 'No shipments found for this sale' });

    const existingWithLabel = rows.find((r) => r.label_url);
    if (existingWithLabel && existingWithLabel.label_url) return res.redirect(existingWithLabel.label_url);

    const shipmentIds = rows.map((r) => r.shiprocket_shipment_id).filter((v) => v != null);
    if (!shipmentIds.length) return res.status(404).json({ ok: false, message: 'No Shiprocket shipment ids found' });

    const sr = new Shiprocket({ pool });
    await sr.init();

    const result = await sr.assignAWBAndLabel({ shipment_id: shipmentIds });
    const labelUrl = result?.label?.label_url || result?.label_url || null;

    if (!labelUrl) return res.status(500).json({ ok: false, message: 'Unable to generate label' });

    return res.redirect(labelUrl);
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch label';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.get('/shiprocket/invoice/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId;
    const { rows } = await pool.query('SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC', [saleId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: 'No shipments found for this sale' });

    const orderIds = Array.from(new Set(rows.map((r) => r.shiprocket_order_id).filter((v) => v != null)));
    if (!orderIds.length) return res.status(404).json({ ok: false, message: 'No Shiprocket order ids found' });

    const sr = new Shiprocket({ pool });
    await sr.init();

    const { data } = await sr.api('post', '/orders/print/invoice', { ids: orderIds });
    const invoiceUrl = data?.invoice_url || data?.data?.invoice_url || null;

    if (!invoiceUrl) return res.status(500).json({ ok: false, message: 'Unable to generate invoice' });

    return res.redirect(invoiceUrl);
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch invoice';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.get('/shiprocket/manifest/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId;
    const { rows } = await pool.query('SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC', [saleId]);
    if (!rows.length) return res.status(404).json({ ok: false, message: 'No shipments found for this sale' });

    const shipmentIds = rows.map((r) => r.shiprocket_shipment_id).filter((v) => v != null);
    if (!shipmentIds.length) return res.status(404).json({ ok: false, message: 'No Shiprocket shipment ids found' });

    const sr = new Shiprocket({ pool });
    await sr.init();

    const data = await sr.generateManifest({ shipment_ids: shipmentIds });
    const manifestUrl = data?.manifest_url || data?.data?.manifest_url || null;

    if (!manifestUrl) return res.status(500).json({ ok: false, message: 'Unable to generate manifest' });

    return res.redirect(manifestUrl);
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch manifest';
    return res.status(500).json({ ok: false, message: msg });
  }
});

module.exports = router;
