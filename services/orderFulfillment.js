const { randomUUID } = require('crypto')
const Shiprocket = require('./shiprocketService')

const FORCE_BRANCH_ID = process.env.SHIPROCKET_FORCE_BRANCH_ID
  ? Number(process.env.SHIPROCKET_FORCE_BRANCH_ID)
  : null

const FALLBACK_BRANCH_ID = process.env.SHIPROCKET_FALLBACK_BRANCH_ID
  ? Number(process.env.SHIPROCKET_FALLBACK_BRANCH_ID)
  : null

function haversineKm(a, b) {
  const toRad = d => (d * Math.PI) / 180
  const R = 6371
  const dLat = toRad((b.lat || 0) - (a.lat || 0))
  const dLon = toRad((b.lng || 0) - (a.lng || 0))
  const lat1 = toRad(a.lat || 0)
  const lat2 = toRad(b.lat || 0)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

async function customerLocFromSale(sale, pool) {
  if (sale.shipping_address?.lat && sale.shipping_address?.lng) {
    return { lat: Number(sale.shipping_address.lat), lng: Number(sale.shipping_address.lng) }
  }
  const pc = sale.shipping_address?.pincode || sale.pincode || null
  if (!pc) return { lat: null, lng: null }
  const { rows } = await pool.query(
    'SELECT AVG(latitude)::float lat, AVG(longitude)::float lng FROM branches WHERE pincode=$1',
    [pc]
  )
  return { lat: rows[0]?.lat || null, lng: rows[0]?.lng || null }
}

async function candidateBranches(pool, variantId, qty) {
  const { rows } = await pool.query(
    `SELECT b.id, b.latitude::float AS lat, b.longitude::float AS lng, b.pincode
     FROM branch_variant_stock s
     JOIN branches b ON b.id = s.branch_id
     WHERE s.variant_id=$1 AND (s.on_hand - s.reserved) >= $2`,
    [variantId, qty]
  )
  return rows
}

async function pickBranchForItem(pool, variantId, qty, sale, customerLoc) {
  if (FORCE_BRANCH_ID != null) return FORCE_BRANCH_ID

  const rows = await candidateBranches(pool, variantId, qty)
  if (!rows.length) {
    if (FALLBACK_BRANCH_ID != null) return FALLBACK_BRANCH_ID
    return null
  }

  const pincode = sale.shipping_address?.pincode || sale.pincode || null
  const samePin = pincode ? rows.filter(r => String(r.pincode) === String(pincode)) : []
  const poolRows = samePin.length ? samePin : rows

  if (customerLoc.lat != null && customerLoc.lng != null) {
    const sorted = poolRows
      .map(r => ({ r, d: haversineKm({ lat: r.lat, lng: r.lng }, customerLoc) }))
      .sort((a, b) => a.d - b.d)
    return sorted[0].r.id
  }

  return poolRows[0].id
}

async function planShipmentsForOrder(sale, pool) {
  if (FORCE_BRANCH_ID != null) {
    return [{ branch_id: FORCE_BRANCH_ID, items: sale.items }]
  }

  const loc = await customerLocFromSale(sale, pool)
  const groups = {}

  for (const it of sale.items) {
    const variantId = Number(it?.variant_id ?? it?.variantId ?? it?.id ?? 0)
    const qty = Number(it?.qty ?? it?.quantity ?? 1)
    if (!variantId || qty <= 0) throw new Error('Invalid item variant/qty')

    const branchId = await pickBranchForItem(pool, variantId, qty, sale, loc)
    if (!branchId) throw new Error(`Out of stock for variant ${variantId}`)

    if (!groups[branchId]) groups[branchId] = []
    groups[branchId].push({ ...it, variant_id: variantId, qty })
  }

  return Object.entries(groups).map(([branch_id, items]) => ({
    branch_id: Number(branch_id),
    items
  }))
}

async function fulfillOrderWithShiprocket(sale, pool) {
  const sr = new Shiprocket({ pool })
  await sr.init()

  const groups = await planShipmentsForOrder(sale, pool)
  const created = []
  const manifestShipmentIds = []

  const payable =
    typeof sale.totals === 'object' && sale.totals !== null ? Number(sale.totals.payable || 0) : 0

  const paymentMethodForShiprocket =
    String(sale.payment_status || '').toUpperCase() === 'COD' && payable > 0 ? 'COD' : 'Prepaid'

  for (const group of groups) {
    const wh = (
      await pool.query('SELECT * FROM shiprocket_warehouses WHERE branch_id=$1', [group.branch_id])
    ).rows[0]

    if (!wh) throw new Error(`No pickup mapped for branch ${group.branch_id}`)

    const channelOrderId = `${sale.id}-${group.branch_id}`

    const data = await sr.createOrderShipment({
      channel_order_id: channelOrderId,
      pickup_location: wh.name,
      order: {
        items: group.items.map(it => ({
          name: it.name || it.product_name || `Variant ${it.variant_id}`,
          variant_id: Number(it.variant_id),
          qty: Number(it.qty || 1),
          price: Number(it.price || 0)
        })),
        payment_method: paymentMethodForShiprocket
      },
      customer: {
        name: sale.customer_name || 'Customer',
        email: sale.customer_email || null,
        phone: sale.customer_mobile || null,
        address: {
          line1: sale.shipping_address?.line1 || '',
          line2: sale.shipping_address?.line2 || '',
          city: sale.shipping_address?.city || '',
          state: sale.shipping_address?.state || '',
          pincode: sale.shipping_address?.pincode || sale.pincode || ''
        }
      }
    })

    const shipmentId = Array.isArray(data?.shipment_id) ? data.shipment_id[0] : data?.shipment_id || null

    let awb = null
    let labelUrl = null

    if (shipmentId) {
      const res = await sr.assignAWBAndLabel({ shipment_id: shipmentId })
      awb = res.awb?.response?.data?.awb_code || null
      labelUrl = res.label?.label_url || null
      manifestShipmentIds.push(shipmentId)
      await sr.requestPickup({ shipment_id: shipmentId })
    }

    const sid = randomUUID()
    await pool.query(
      `INSERT INTO shipments(
         id,
         sale_id,
         branch_id,
         shiprocket_order_id,
         shiprocket_shipment_id,
         awb,
         label_url,
         tracking_url,
         status
       )
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
        awb ? 'READY' : 'CREATED'
      ]
    )

    created.push({
      branch_id: group.branch_id,
      shipment_id: shipmentId,
      awb,
      label_url: labelUrl
    })
  }

  if (manifestShipmentIds.length) {
    await sr.generateManifest({ shipment_ids: manifestShipmentIds })
  }

  return created
}

module.exports = { fulfillOrderWithShiprocket }
