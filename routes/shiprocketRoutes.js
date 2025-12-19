const express = require('express');
const pool = require('../db');
const Shiprocket = require('../services/shiprocketService');
const { fulfillOrderWithShiprocket } = require('../services/orderFulfillment');

const router = express.Router();

const safeJson = (v) => {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

const getSaleWithItems = async (saleId) => {
  const saleRes = await pool.query('SELECT * FROM sales WHERE id=$1', [saleId]);
  if (!saleRes.rows.length) return { sale: null, items: [] };
  const sale = saleRes.rows[0];
  const items = (await pool.query('SELECT * FROM sale_items WHERE sale_id=$1', [saleId])).rows;
  return { sale, items };
};

const getLatestShipmentForSale = async (saleId) => {
  const { rows } = await pool.query(
    'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at DESC',
    [saleId]
  );
  return rows.length ? rows[0] : null;
};

const resolvePinsForServiceability = async (sale) => {
  const branchId = sale?.branch_id || null;

  let pickupPin = null;
  if (branchId) {
    const wh = await pool.query(
      'SELECT pincode FROM shiprocket_warehouses WHERE branch_id=$1 LIMIT 1',
      [branchId]
    );
    pickupPin = String(wh.rows[0]?.pincode || '').trim() || null;
  }

  if (!pickupPin && branchId) {
    const br = await pool.query(
      'SELECT pincode FROM branches WHERE id=$1 LIMIT 1',
      [branchId]
    );
    pickupPin = String(br.rows[0]?.pincode || '').trim() || null;
  }

  if (!pickupPin) {
    const any = await pool.query(
      'SELECT pincode FROM branches WHERE is_active = true AND pincode IS NOT NULL LIMIT 1'
    );
    pickupPin = String(any.rows[0]?.pincode || '').trim() || null;
  }

  const shipAddr = safeJson(sale?.shipping_address) || {};
  const deliveryPin =
    String(
      sale?.shipping_pincode ||
        shipAddr?.pincode ||
        sale?.pincode ||
        sale?.delivery_pincode ||
        ''
    ).trim() || null;

  return { pickupPin, deliveryPin };
};

const serviceabilityHandler = async (req, res) => {
  try {
    const saleId = req.params.saleId || req.params.id || req.params.sale_id || null;
    if (!saleId) return res.status(400).json({ ok: false, message: 'Missing saleId' });

    const { sale, items } = await getSaleWithItems(saleId);
    if (!sale) return res.status(404).json({ ok: false, message: 'Sale not found' });

    const { pickupPin, deliveryPin } = await resolvePinsForServiceability(sale);

    if (!pickupPin) return res.status(500).json({ ok: false, message: 'No pickup pincode configured' });
    if (!deliveryPin || String(deliveryPin).length !== 6) {
      return res.status(400).json({ ok: false, message: 'Invalid delivery pincode for this sale' });
    }

    const sr = new Shiprocket({ pool });
    await sr.init();

    const paymentMethod = String(sale?.payment_method || sale?.payment_type || sale?.payment_status || '').toUpperCase();
    const cod = paymentMethod === 'COD' || paymentMethod === 'CASH_ON_DELIVERY' || paymentMethod === 'CASH';

    const weight = Number(sale?.weight || 0.5) || 0.5;

    const data = await sr.checkServiceability({
      pickup_postcode: pickupPin,
      delivery_postcode: deliveryPin,
      cod,
      weight
    });

    const list = Array.isArray(data?.data?.available_courier_companies)
      ? data.data.available_courier_companies
      : [];

    return res.json({
      ok: true,
      sale_id: saleId,
      pickup_postcode: pickupPin,
      delivery_postcode: deliveryPin,
      cod,
      weight,
      data
    });
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to check serviceability';
    return res.status(500).json({ ok: false, message: msg });
  }
};

router.get('/shiprocket/warehouses', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, branch_id, warehouse_id, name, pincode, city, state, address, phone, created_at, updated_at FROM shiprocket_warehouses ORDER BY id ASC'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: 'Failed to fetch warehouses' });
  }
});

router.post('/shiprocket/warehouses/import', async (req, res) => {
  try {
    const sr = new Shiprocket({ pool });
    await sr.init();
    const { data } = await sr.api('get', '/settings/company/pickup');
    const pickups = Array.isArray(data?.data?.shipping_address)
      ? data.data.shipping_address
      : [];
    const { rows: branches } = await pool.query(
      'SELECT id, name, address, city, state, pincode, phone FROM branches WHERE is_active = true'
    );
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
    const { rows: branches } = await pool.query(
      'SELECT id, name, address, city, state, pincode, phone, email FROM branches WHERE is_active = true'
    );
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
    if (!saleRes.rows.length) return res.status(404).json({ message: 'Sale not found' });
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

router.get('/shiprocket/pincode', async (req, res) => {
  try {
    const deliveryPin = String(req.query.pincode || '').trim();
    if (!deliveryPin || deliveryPin.length !== 6) {
      return res.status(400).json({ ok: false, message: 'Invalid pincode' });
    }

    const { rows } = await pool.query(
      'SELECT pincode FROM branches WHERE is_active = true AND pincode IS NOT NULL LIMIT 1'
    );
    const pickupPin = String(rows[0]?.pincode || '').trim();
    if (!pickupPin) {
      return res.status(500).json({ ok: false, message: 'No pickup pincode configured' });
    }

    const sr = new Shiprocket({ pool });
    await sr.init();

    const data = await sr.checkServiceability({
      pickup_postcode: pickupPin,
      delivery_postcode: deliveryPin,
      cod: true,
      weight: 0.5
    });

    const list = Array.isArray(data?.data?.available_courier_companies)
      ? data.data.available_courier_companies
      : [];

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

router.get('/shiprocket/label/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId;
    const { rows } = await pool.query(
      'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at DESC',
      [saleId]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'No shipments found for this sale' });
    }
    const existingWithLabel = rows.find((r) => r.label_url);
    if (existingWithLabel && existingWithLabel.label_url) {
      return res.redirect(existingWithLabel.label_url);
    }
    const shipmentIds = rows
      .map((r) => r.shiprocket_shipment_id)
      .filter((v) => v != null);
    if (!shipmentIds.length) {
      return res.status(404).json({ ok: false, message: 'No Shiprocket shipment ids found' });
    }
    const sr = new Shiprocket({ pool });
    await sr.init();
    const result = await sr.assignAWBAndLabel({ shipment_id: shipmentIds });
    const labelUrl =
      result?.label?.label_url ||
      result?.label_url ||
      null;
    if (!labelUrl) {
      return res.status(500).json({ ok: false, message: 'Unable to generate label' });
    }
    return res.redirect(labelUrl);
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch label';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.get('/shiprocket/invoice/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId;
    const { rows } = await pool.query(
      'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC',
      [saleId]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'No shipments found for this sale' });
    }
    const orderIds = Array.from(
      new Set(
        rows
          .map((r) => r.shiprocket_order_id)
          .filter((v) => v != null)
      )
    );
    if (!orderIds.length) {
      return res.status(404).json({ ok: false, message: 'No Shiprocket order ids found' });
    }
    const sr = new Shiprocket({ pool });
    await sr.init();
    const { data } = await sr.api('post', '/orders/print/invoice', { ids: orderIds });
    const invoiceUrl =
      data?.invoice_url ||
      data?.data?.invoice_url ||
      null;
    if (!invoiceUrl) {
      return res.status(500).json({ ok: false, message: 'Unable to generate invoice' });
    }
    return res.redirect(invoiceUrl);
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch invoice';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.get('/shiprocket/manifest/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId;
    const { rows } = await pool.query(
      'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC',
      [saleId]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'No shipments found for this sale' });
    }
    const shipmentIds = rows
      .map((r) => r.shiprocket_shipment_id)
      .filter((v) => v != null);
    if (!shipmentIds.length) {
      return res.status(404).json({ ok: false, message: 'No Shiprocket shipment ids found' });
    }
    const sr = new Shiprocket({ pool });
    await sr.init();
    const data = await sr.generateManifest({ shipment_ids: shipmentIds });
    const manifestUrl =
      data?.manifest_url ||
      data?.data?.manifest_url ||
      null;
    if (!manifestUrl) {
      return res.status(500).json({ ok: false, message: 'Unable to generate manifest' });
    }
    return res.redirect(manifestUrl);
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch manifest';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.get('/shiprocket/serviceability/:saleId', serviceabilityHandler);
router.get('/shiprocket/serviceability/by-sale/:saleId', serviceabilityHandler);
router.get('/shiprocket/serviceability/sale/:saleId', serviceabilityHandler);

router.post('/shiprocket/assign-courier', async (req, res) => {
  try {
    const saleId = req.body?.sale_id || null;
    const courierCompanyId = Number(req.body?.courier_company_id || 0) || 0;
    if (!saleId) return res.status(400).json({ ok: false, message: 'Missing sale_id' });
    if (!courierCompanyId) return res.status(400).json({ ok: false, message: 'Missing courier_company_id' });

    const { sale, items } = await getSaleWithItems(saleId);
    if (!sale) return res.status(404).json({ ok: false, message: 'Sale not found' });

    sale.items = items;

    let shipment = await getLatestShipmentForSale(saleId);
    if (!shipment || !shipment.shiprocket_shipment_id) {
      await fulfillOrderWithShiprocket(sale, pool);
      shipment = await getLatestShipmentForSale(saleId);
    }

    if (!shipment || !shipment.shiprocket_shipment_id) {
      return res.status(500).json({ ok: false, message: 'Shipment not created for this sale' });
    }

    const sr = new Shiprocket({ pool });
    await sr.init();

    const shiprocketShipmentId = Number(shipment.shiprocket_shipment_id);
    const { data: awbData } = await sr.api('post', '/courier/assign/awb', {
      shipment_id: [shiprocketShipmentId],
      courier_company_id: courierCompanyId
    });

    const { data: labelData } = await sr.api('post', '/courier/generate/label', {
      shipment_id: [shiprocketShipmentId]
    });

    const awb =
      awbData?.awb_code ||
      awbData?.data?.awb_code ||
      awbData?.response?.data?.awb_code ||
      awbData?.awb ||
      null;

    const courierName =
      awbData?.courier_name ||
      awbData?.data?.courier_name ||
      null;

    const labelUrl =
      labelData?.label_url ||
      labelData?.data?.label_url ||
      null;

    await pool.query(
      `UPDATE shipments
       SET awb=COALESCE($1, awb),
           courier_company_id=COALESCE($2, courier_company_id),
           courier_name=COALESCE($3, courier_name),
           label_url=COALESCE($4, label_url),
           updated_at=NOW()
       WHERE id=$5`,
      [awb, courierCompanyId, courierName, labelUrl, shipment.id]
    );

    const updated = await pool.query('SELECT * FROM shipments WHERE id=$1', [shipment.id]);

    return res.json({
      ok: true,
      sale_id: saleId,
      shipment: updated.rows[0] || shipment,
      awb,
      courier_company_id: courierCompanyId,
      courier_name: courierName,
      label_url: labelUrl,
      raw: { awb: awbData, label: labelData }
    });
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to assign courier / generate AWB';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.post('/shiprocket/assign-awb', async (req, res) => {
  try {
    const saleId = req.body?.sale_id || null;
    const courierCompanyId = Number(req.body?.courier_company_id || 0) || 0;
    if (!saleId) return res.status(400).json({ ok: false, message: 'Missing sale_id' });
    if (!courierCompanyId) return res.status(400).json({ ok: false, message: 'Missing courier_company_id' });

    req.body.sale_id = saleId;
    req.body.courier_company_id = courierCompanyId;

    return router.handle(req, res, () => {});
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to assign AWB';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.post('/shiprocket/assign-courier/by-sale/:saleId', async (req, res) => {
  req.body = req.body || {};
  req.body.sale_id = req.params.saleId;
  req.body.courier_company_id = req.body.courier_company_id || req.body.courierCompanyId;
  return router.handle(
    { ...req, url: '/shiprocket/assign-courier', method: 'POST' },
    res,
    () => {}
  );
});

router.post('/shiprocket/pickup', async (req, res) => {
  try {
    const sr = new Shiprocket({ pool });
    await sr.init();

    let ids = req.body?.shipment_id;
    if (!Array.isArray(ids)) ids = ids != null ? [ids] : [];
    ids = ids.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);

    if (!ids.length) return res.status(400).json({ ok: false, message: 'Missing shipment_id' });

    const data = await sr.requestPickup({ shipment_id: ids });
    return res.json({ ok: true, data });
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to request pickup';
    return res.status(500).json({ ok: false, message: msg });
  }
});

router.post('/shiprocket/pickup/by-sale/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId;
    let shipment = await getLatestShipmentForSale(saleId);
    if (!shipment || !shipment.shiprocket_shipment_id) {
      const { sale, items } = await getSaleWithItems(saleId);
      if (!sale) return res.status(404).json({ ok: false, message: 'Sale not found' });
      sale.items = items;
      await fulfillOrderWithShiprocket(sale, pool);
      shipment = await getLatestShipmentForSale(saleId);
    }

    if (!shipment || !shipment.shiprocket_shipment_id) {
      return res.status(500).json({ ok: false, message: 'Shipment not created for this sale' });
    }

    const sr = new Shiprocket({ pool });
    await sr.init();

    const data = await sr.requestPickup({ shipment_id: [Number(shipment.shiprocket_shipment_id)] });
    return res.json({ ok: true, data });
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to request pickup';
    return res.status(500).json({ ok: false, message: msg });
  }
});

module.exports = router;
