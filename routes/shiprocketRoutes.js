const express = require('express')
const pool = require('../db')
const Shiprocket = require('../services/shiprocketService')
const { fulfillOrderWithShiprocket } = require('../services/orderFulfillment')

const router = express.Router()

const asUpper = (v) => String(v ?? '').trim().toUpperCase()

const safeJsonParse = (v) => {
  if (!v) return null
  if (typeof v === 'object') return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

const pickDeliveryPincode = (saleRow) => {
  const direct =
    saleRow?.delivery_pincode ||
    saleRow?.pincode ||
    saleRow?.shipping_pincode ||
    saleRow?.customer_pincode
  if (direct) return String(direct).trim()

  const addr = safeJsonParse(saleRow?.shipping_address)
  const pin =
    addr?.pincode ||
    addr?.pin_code ||
    addr?.postal_code ||
    addr?.zip
  if (pin) return String(pin).trim()

  return ''
}

const pickCod = (saleRow) => {
  const ps = asUpper(saleRow?.payment_status)
  const pm = asUpper(saleRow?.payment_method || saleRow?.payment_mode)
  if (ps === 'COD') return true
  if (pm.includes('COD') || pm.includes('CASH')) return true
  return false
}

const computeWeightKg = (items) => {
  if (!Array.isArray(items) || !items.length) return 0.5
  let total = 0
  for (const it of items) {
    const qty = Number(it?.qty ?? it?.quantity ?? 1) || 1
    const w =
      Number(it?.weight_kg) ||
      Number(it?.weight) ||
      Number(it?.weight_in_kg) ||
      0
    if (w > 0) total += w * qty
  }
  if (total > 0) return Number(total.toFixed(3))
  return 0.5
}

const getPickupPincodeForSale = async (saleRow) => {
  const branchId = saleRow?.branch_id || null
  if (branchId) {
    const wh = await pool.query(
      'SELECT pincode FROM shiprocket_warehouses WHERE branch_id=$1 LIMIT 1',
      [branchId]
    )
    const wpin = String(wh.rows[0]?.pincode || '').trim()
    if (wpin && wpin.length === 6) return wpin

    const br = await pool.query(
      'SELECT pincode FROM branches WHERE id=$1 LIMIT 1',
      [branchId]
    )
    const bpin = String(br.rows[0]?.pincode || '').trim()
    if (bpin && bpin.length === 6) return bpin
  }

  const any = await pool.query(
    'SELECT pincode FROM branches WHERE is_active = true AND pincode IS NOT NULL LIMIT 1'
  )
  const apin = String(any.rows[0]?.pincode || '').trim()
  if (apin && apin.length === 6) return apin
  return ''
}

const pickLabelUrl = (data) => {
  return (
    data?.label_url ||
    data?.label?.label_url ||
    data?.data?.label_url ||
    data?.data?.label?.label_url ||
    null
  )
}

const pickManifestUrl = (data) => {
  return data?.manifest_url || data?.data?.manifest_url || null
}

const pickInvoiceUrl = (data) => {
  return data?.invoice_url || data?.data?.invoice_url || null
}

router.get('/shiprocket/warehouses', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, branch_id, warehouse_id, name, pincode, city, state, address, phone, created_at, updated_at FROM shiprocket_warehouses ORDER BY id ASC'
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ ok: false, message: 'Failed to fetch warehouses' })
  }
})

router.post('/shiprocket/warehouses/import', async (req, res) => {
  try {
    const sr = new Shiprocket({ pool })
    await sr.init()
    const { data } = await sr.api('get', '/settings/company/pickup')
    const pickups = Array.isArray(data?.data?.shipping_address) ? data.data.shipping_address : []
    const { rows: branches } = await pool.query(
      'SELECT id, name, address, city, state, pincode, phone FROM branches WHERE is_active = true'
    )
    const norm = (s) => String(s ?? '').trim().toLowerCase()
    const results = []
    for (const b of branches) {
      const bpincode = String(b.pincode || '').trim()
      let best = null
      if (bpincode) best = pickups.find((p) => String(p.pin_code || '').trim() === bpincode)
      if (!best && b.city) {
        const cityNorm = norm(b.city)
        best = pickups.find((p) => norm(p.city) === cityNorm)
      }
      if (!best) {
        results.push({ branch_id: b.id, error: 'No matching pickup found in Shiprocket' })
        continue
      }
      const pickupName = best.pickup_location || best.name || b.name
      const pickupId = best.pickup_id || best.id || best.rto_address_id || 0
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
      )
      results.push({ branch_id: b.id, mapped_to: pickupName, pickup_id: pickupId })
    }
    res.json({ ok: true, results })
  } catch (e) {
    const msg = e.response?.data || e.message || 'import failed'
    res.status(500).json({ ok: false, message: msg })
  }
})

router.post('/shiprocket/warehouses/sync', async (req, res) => {
  try {
    const sr = new Shiprocket({ pool })
    await sr.init()
    const { rows: branches } = await pool.query(
      'SELECT id, name, address, city, state, pincode, phone, email FROM branches WHERE is_active = true'
    )
    const results = []
    for (const b of branches) {
      try {
        const data = await sr.upsertWarehouseFromBranch(b)
        const pickupName = data?.pickup_location || `${b.name} - ${b.pincode}`
        await pool.query(
          `INSERT INTO shiprocket_warehouses (branch_id, warehouse_id, name, pincode, city, state, address, phone)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (branch_id) DO UPDATE 
           SET warehouse_id=EXCLUDED.warehouse_id, name=EXCLUDED.name, pincode=EXCLUDED.pincode, 
               city=EXCLUDED.city, state=EXCLUDED.state, address=EXCLUDED.address, phone=EXCLUDED.phone`,
          [b.id, data?.pickup_id || 0, pickupName, b.pincode, b.city, b.state, b.address, b.phone]
        )
        results.push({ branch_id: b.id, pickup: pickupName })
      } catch (innerErr) {
        results.push({ branch_id: b.id, error: innerErr.response?.data || innerErr.message })
      }
    }
    res.json({ ok: true, results })
  } catch (e) {
    const errData = e.response?.data || e.message || 'sync failed'
    res.status(500).json({ ok: false, message: errData })
  }
})

router.post('/shiprocket/fulfill/:id', async (req, res) => {
  try {
    const id = req.params.id
    const saleRes = await pool.query('SELECT * FROM sales WHERE id=$1', [id])
    if (!saleRes.rows.length) return res.status(404).json({ message: 'Sale not found' })
    const sale = saleRes.rows[0]
    const items = (await pool.query('SELECT * FROM sale_items WHERE sale_id=$1', [id])).rows
    sale.items = items
    const shipments = await fulfillOrderWithShiprocket(sale, pool)
    res.json({ ok: true, shipments })
  } catch (e) {
    const errData = e.response?.data || e.message || 'fulfillment failed'
    res.status(500).json({ ok: false, message: errData })
  }
})

router.post('/shiprocket/webhook', async (req, res) => {
  try {
    const payload = req.body || {}
    const shipmentId = payload?.shipment_id || payload?.data?.shipment_id || null
    const status = payload?.current_status || payload?.data?.current_status || null
    if (shipmentId && status) {
      await pool.query('UPDATE shipments SET status=$1 WHERE shiprocket_shipment_id=$2', [status, shipmentId])
    }
    res.json({ ok: true })
  } catch {
    res.status(200).json({ ok: true })
  }
})

router.get('/shiprocket/pincode', async (req, res) => {
  try {
    const deliveryPin = String(req.query.pincode || '').trim()
    if (!deliveryPin || deliveryPin.length !== 6) {
      return res.status(400).json({ ok: false, message: 'Invalid pincode' })
    }

    const { rows } = await pool.query(
      'SELECT pincode FROM branches WHERE is_active = true AND pincode IS NOT NULL LIMIT 1'
    )
    const pickupPin = String(rows[0]?.pincode || '').trim()
    if (!pickupPin) {
      return res.status(500).json({ ok: false, message: 'No pickup pincode configured' })
    }

    const sr = new Shiprocket({ pool })
    await sr.init()

    const data = await sr.checkServiceability({
      pickup_postcode: pickupPin,
      delivery_postcode: deliveryPin,
      cod: true,
      weight: 0.5
    })

    const list = Array.isArray(data?.data?.available_courier_companies)
      ? data.data.available_courier_companies
      : []

    const serviceable = list.length > 0

    return res.json({
      ok: true,
      serviceable,
      est_delivery: list[0]?.etd || null,
      cod_available: list.some((c) => Number(c.cod) === 1)
    })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to check pincode'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/couriers/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId
    const saleRes = await pool.query('SELECT * FROM sales WHERE id=$1', [saleId])
    if (!saleRes.rows.length) return res.status(404).json({ ok: false, message: 'Sale not found' })
    const sale = saleRes.rows[0]

    const items = (await pool.query('SELECT * FROM sale_items WHERE sale_id=$1', [saleId])).rows
    const pickup_postcode = await getPickupPincodeForSale(sale)
    const delivery_postcode = pickDeliveryPincode(sale)
    if (!pickup_postcode || pickup_postcode.length !== 6) {
      return res.status(500).json({ ok: false, message: 'No pickup pincode configured' })
    }
    if (!delivery_postcode || delivery_postcode.length !== 6) {
      return res.status(400).json({ ok: false, message: 'Invalid delivery pincode' })
    }

    const cod = pickCod(sale)
    const weight = computeWeightKg(items)

    const sr = new Shiprocket({ pool })
    await sr.init()

    const { data } = await sr.api('get', '/courier/serviceability/', {
      pickup_postcode,
      delivery_postcode,
      cod: cod ? 1 : 0,
      weight: String(weight)
    })

    const avail = Array.isArray(data?.data?.available_courier_companies)
      ? data.data.available_courier_companies
      : []

    const blocked = Array.isArray(data?.data?.blocked_courier_companies)
      ? data.data.blocked_courier_companies
      : []

    res.json({
      ok: true,
      pickup_postcode,
      delivery_postcode,
      cod,
      weight,
      recommended_courier_company_id:
        data?.data?.recommended_courier_company_id ??
        data?.data?.shiprocket_recommended_courier_id ??
        null,
      available_courier_companies: avail,
      blocked_courier_companies: blocked
    })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch couriers'
    res.status(500).json({ ok: false, message: msg })
  }
})

router.post('/shiprocket/courier/assign', async (req, res) => {
  try {
    const saleId = req.body?.sale_id || req.body?.saleId || null
    const courierCompanyId =
      req.body?.courier_company_id ??
      req.body?.courierCompanyId ??
      req.body?.courier_id ??
      req.body?.courierId ??
      null
    const shipmentId = req.body?.shipment_id ?? req.body?.shipmentId ?? null

    if (!saleId) return res.status(400).json({ ok: false, message: 'sale_id is required' })
    if (!courierCompanyId) return res.status(400).json({ ok: false, message: 'courier_company_id is required' })

    let shipmentRows = []
    if (shipmentId) {
      const { rows } = await pool.query(
        'SELECT * FROM shipments WHERE sale_id=$1 AND shiprocket_shipment_id=$2 ORDER BY created_at ASC',
        [saleId, shipmentId]
      )
      shipmentRows = rows
    } else {
      const { rows } = await pool.query(
        'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC',
        [saleId]
      )
      shipmentRows = rows
    }

    const shiprocketShipmentIds = shipmentRows
      .map((r) => r.shiprocket_shipment_id)
      .filter((v) => v != null)

    if (!shiprocketShipmentIds.length) {
      return res.status(404).json({ ok: false, message: 'No Shiprocket shipment ids found' })
    }

    const sr = new Shiprocket({ pool })
    await sr.init()

    const { data: awb } = await sr.api('post', '/courier/assign/awb', {
      shipment_id: shiprocketShipmentIds,
      courier_id: Number(courierCompanyId)
    })

    const { data: label } = await sr.api('post', '/courier/generate/label', {
      shipment_id: shiprocketShipmentIds
    })

    const labelUrl = pickLabelUrl(label)

    if (labelUrl) {
      await pool.query(
        'UPDATE shipments SET label_url=$1 WHERE sale_id=$2 AND shiprocket_shipment_id = ANY($3::int[])',
        [labelUrl, saleId, shiprocketShipmentIds]
      )
    }

    res.json({ ok: true, awb, label, label_url: labelUrl })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to assign courier'
    res.status(500).json({ ok: false, message: msg })
  }
})

router.post('/shiprocket/pickup/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId
    const { rows } = await pool.query(
      'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at DESC',
      [saleId]
    )
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'No shipments found for this sale' })
    }
    const shiprocketShipmentId = rows[0]?.shiprocket_shipment_id
    if (!shiprocketShipmentId) {
      return res.status(404).json({ ok: false, message: 'No Shiprocket shipment id found' })
    }

    const sr = new Shiprocket({ pool })
    await sr.init()

    const data = await sr.requestPickup({
      shipment_id: [shiprocketShipmentId],
      pickup_date: req.body?.pickup_date || null,
      status: req.body?.status || null
    })

    res.json({ ok: true, data })
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to request pickup'
    res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/label/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId
    const { rows } = await pool.query(
      'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at DESC',
      [saleId]
    )
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'No shipments found for this sale' })
    }
    const existingWithLabel = rows.find((r) => r.label_url)
    if (existingWithLabel && existingWithLabel.label_url) {
      return res.redirect(existingWithLabel.label_url)
    }
    const shipmentIds = rows
      .map((r) => r.shiprocket_shipment_id)
      .filter((v) => v != null)
    if (!shipmentIds.length) {
      return res.status(404).json({ ok: false, message: 'No Shiprocket shipment ids found' })
    }
    const sr = new Shiprocket({ pool })
    await sr.init()
    const result = await sr.assignAWBAndLabel({ shipment_id: shipmentIds })
    const labelUrl = pickLabelUrl(result)
    if (!labelUrl) {
      return res.status(500).json({ ok: false, message: 'Unable to generate label' })
    }
    try {
      await pool.query(
        'UPDATE shipments SET label_url=$1 WHERE sale_id=$2 AND shiprocket_shipment_id = ANY($3::int[])',
        [labelUrl, saleId, shipmentIds]
      )
    } catch {}
    return res.redirect(labelUrl)
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch label'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/invoice/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId
    const { rows } = await pool.query(
      'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC',
      [saleId]
    )
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'No shipments found for this sale' })
    }
    const orderIds = Array.from(
      new Set(
        rows
          .map((r) => r.shiprocket_order_id)
          .filter((v) => v != null)
      )
    )
    if (!orderIds.length) {
      return res.status(404).json({ ok: false, message: 'No Shiprocket order ids found' })
    }
    const sr = new Shiprocket({ pool })
    await sr.init()
    const { data } = await sr.api('post', '/orders/print/invoice', { ids: orderIds })
    const invoiceUrl = pickInvoiceUrl(data)
    if (!invoiceUrl) {
      return res.status(500).json({ ok: false, message: 'Unable to generate invoice' })
    }
    return res.redirect(invoiceUrl)
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch invoice'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/manifest/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId
    const { rows } = await pool.query(
      'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC',
      [saleId]
    )
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'No shipments found for this sale' })
    }
    const shipmentIds = rows
      .map((r) => r.shiprocket_shipment_id)
      .filter((v) => v != null)
    if (!shipmentIds.length) {
      return res.status(404).json({ ok: false, message: 'No Shiprocket shipment ids found' })
    }
    const sr = new Shiprocket({ pool })
    await sr.init()
    const data = await sr.generateManifest({ shipment_ids: shipmentIds })
    const manifestUrl = pickManifestUrl(data)
    if (!manifestUrl) {
      return res.status(500).json({ ok: false, message: 'Unable to generate manifest' })
    }
    return res.redirect(manifestUrl)
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to fetch manifest'
    return res.status(500).json({ ok: false, message: msg })
  }
})

router.get('/shiprocket/manifest/print/:saleId', async (req, res) => {
  try {
    const saleId = req.params.saleId
    const { rows } = await pool.query(
      'SELECT * FROM shipments WHERE sale_id=$1 ORDER BY created_at ASC',
      [saleId]
    )
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'No shipments found for this sale' })
    }
    const orderIds = Array.from(
      new Set(
        rows
          .map((r) => r.shiprocket_order_id)
          .filter((v) => v != null)
      )
    )
    if (!orderIds.length) {
      return res.status(404).json({ ok: false, message: 'No Shiprocket order ids found' })
    }

    const sr = new Shiprocket({ pool })
    await sr.init()

    const { data } = await sr.api('post', '/manifests/print', { order_ids: orderIds })
    const manifestUrl = pickManifestUrl(data)
    if (!manifestUrl) {
      return res.status(500).json({ ok: false, message: 'Unable to print manifest' })
    }
    return res.redirect(manifestUrl)
  } catch (e) {
    const msg = e.response?.data || e.message || 'Failed to print manifest'
    return res.status(500).json({ ok: false, message: msg })
  }
})

module.exports = router
