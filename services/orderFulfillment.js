const { randomUUID } = require('crypto');
const Shiprocket = require('./shiprocketService');

function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad((b.lat || 0) - (a.lat || 0));
  const dLon = toRad((b.lng || 0) - (a.lng || 0));
  const lat1 = toRad(a.lat || 0);
  const lat2 = toRad(b.lat || 0);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function customerLocFromSale(sale, pool) {
  if (sale.shipping_address?.lat && sale.shipping_address?.lng) {
    return { lat: Number(sale.shipping_address.lat), lng: Number(sale.shipping_address.lng) };
  }
  const pc = sale.shipping_address?.pincode || sale.pincode || null;
  if (!pc) return { lat: null, lng: null };
  const { rows } = await pool.query('SELECT AVG(latitude)::float lat, AVG(longitude)::float lng FROM branches WHERE pincode=$1', [pc]);
  return { lat: rows[0]?.lat || null, lng: rows[0]?.lng || null };
}

async function candidateBranches(pool, variantId, qty) {
  const { rows } = await pool.query(
    `SELECT b.id, b.latitude::float AS lat, b.longitude::float AS lng, b.pincode
     FROM branch_variant_stock s
     JOIN branches b ON b.id = s.branch_id
     WHERE s.variant_id=$1 AND (s.on_hand - s.reserved) >= $2`,
    [variantId, qty]
  );
  return rows;
}

async function pickBranchForItem(pool, variantId, qty, sale, customerLoc) {
  const rows = await candidateBranches(pool, variantId, qty);
  if (!rows.length) return null;
  const pincode = sale.shipping_address?.pincode || sale.pincode || null;
  const samePin = pincode ? rows.filter((r) => String(r.pincode) === String(pincode)) : [];
  const poolRows = samePin.length ? samePin : rows;
  if (customerLoc.lat != null && customerLoc.lng != null) {
    const sorted = poolRows
      .map((r) => ({ r, d: haversineKm({ lat: r.lat, lng: r.lng }, customerLoc) }))
      .sort((a, b) => a.d - b.d);
    return sorted[0].r.id;
  }
  return poolRows[0].id;
}

async function planShipmentsForOrder(sale, pool) {
  const loc = await customerLocFromSale(sale, pool);
  const groups = {};
  for (const it of sale.items) {
    const branchId = await pickBranchForItem(pool, it.variant_id, it.qty, sale, loc);
    if (!branchId) throw new Error(`Out of stock for variant ${it.variant_id}`);
    if (!groups[branchId]) groups[branchId] = [];
    groups[branchId].push(it);
  }
  return Object.entries(groups).map(([branch_id, items]) => ({ branch_id: Number(branch_id), items }));
}

async function fulfillOrderWithShiprocket(sale, pool) {
  const sr = new Shiprocket({ pool });
  await sr.init();
  const groups = await planShipmentsForOrder(sale, pool);
  const created = [];
  for (const group of groups) {
    const wh = (await pool.query('SELECT * FROM shiprocket_warehouses WHERE branch_id=$1', [group.branch_id])).rows[0];
    if (!wh) throw new Error(`No pickup mapped for branch ${group.branch_id}`);
    const channelOrderId = `${sale.id}-${group.branch_id}`;
    const data = await sr.createOrderShipment({
      channel_order_id: channelOrderId,
      pickup_location: wh.name,
      order: {
        items: group.items,
        payment_method: sale.payment_status === 'COD' ? 'COD' : 'Prepaid'
      },
      customer: {
        name: sale.customer_name || 'Customer',
        email: sale.customer_email || null,
        phone: sale.customer_mobile || null,
        address: {
          line1: sale.shipping_address?.line1 || sale.shipping_address || '',
          line2: sale.shipping_address?.line2 || '',
          city: sale.shipping_address?.city || '',
          state: sale.shipping_address?.state || '',
          pincode: sale.shipping_address?.pincode || sale.pincode || ''
        }
      }
    });
    const shipmentId = Array.isArray(data?.shipment_id) ? data.shipment_id[0] : data?.shipment_id || null;
    let awb = null, labelUrl = null;
    if (shipmentId) {
      const res = await sr.assignAWBAndLabel({ shipment_id: shipmentId });
      awb = res.awb?.response?.data?.awb_code || null;
      labelUrl = res.label?.label_url || null;
    }
    const sid = randomUUID();
    await pool.query(
      `INSERT INTO shipments(id, sale_id, branch_id, shiprocket_order_id, shiprocket_shipment_id, awb, label_url, tracking_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        sid,
        sale.id,
        group.branch_id,
        data?.order_id || null,
        shipmentId,
        awb,
        labelUrl,
        data?.tracking_url || null,
        'CREATED'
      ]
    );
    created.push({ branch_id: group.branch_id, shipment_id: shipmentId, awb, label_url: labelUrl });
  }
  return created;
}

module.exports = { fulfillOrderWithShiprocket };
