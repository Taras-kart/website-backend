// services/whatsapp.js
// Meta WhatsApp Cloud API integration for Taras Kart
// Requires: WHATSAPP_PHONE_ID, WHATSAPP_TOKEN in env vars

const GRAPH_API_VERSION = 'v19.0'

function getUrl() {
  const phoneId = process.env.WHATSAPP_PHONE_ID
  if (!phoneId) throw new Error('WHATSAPP_PHONE_ID is not set')
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneId}/messages`
}

function getHeaders() {
  const token = process.env.WHATSAPP_TOKEN
  if (!token) throw new Error('WHATSAPP_TOKEN is not set')
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
}

/**
 * Normalise an Indian mobile number to the format Meta expects: 91XXXXXXXXXX
 * Accepts: 9876543210 / 09876543210 / 919876543210 / +919876543210
 * Returns null if the number is invalid.
 */
function normalisePhone(raw) {
  if (!raw) return null
  let clean = String(raw).replace(/\D/g, '')
  if (clean.length === 12 && clean.startsWith('91')) return clean
  if (clean.length === 11 && clean.startsWith('0')) clean = clean.slice(1)
  if (clean.length === 10 && /^[6-9]/.test(clean)) return `91${clean}`
  return null
}

/**
 * Low-level send to Meta API.
 * Returns { message_id } on success.
 * Throws on failure — always wrap callers in try/catch.
 */
async function sendToMeta(body) {
  const res = await fetch(getUrl(), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body)
  })
  const data = await res.json()
  if (!res.ok) {
    console.error('Meta WhatsApp API error:', JSON.stringify(data))
    throw new Error(data?.error?.message || `Meta API returned ${res.status}`)
  }
  return { message_id: data?.messages?.[0]?.id }
}

/**
 * Send a pre-approved template message.
 * templateName must match exactly what you created in Meta Business Manager.
 * variables is an array of strings matching the {{1}}, {{2}}, ... placeholders.
 */
async function sendTemplate(to, templateName, variables) {
  const phone = normalisePhone(to)
  if (!phone) {
    console.warn(`WhatsApp: invalid phone number skipped — "${to}"`)
    return null
  }
  return sendToMeta({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en' },
      components: [
        {
          type: 'body',
          parameters: variables.map(text => ({ type: 'text', text: String(text) }))
        }
      ]
    }
  })
}

// ─── Taras Kart specific message senders ────────────────────────────────────

/**
 * Message 1 — Order placed (COD or Online payment initiated).
 * Template name: order_confirmed
 * Variables: customer_name, order_id, item_count, total_amount, payment_method
 */
async function sendOrderConfirmed(mobile, { customerName, orderId, itemCount, totalAmount, paymentMethod }) {
  return sendTemplate(mobile, 'order_confirmed', [
    customerName || 'Customer',
    orderId,
    String(itemCount), // product names or count
    String(totalAmount),
    paymentMethod
  ])
}

/**
 * Message 2 — Order shipped with AWB and tracking link.
 * Template name: order_shipped
 * Variables: customer_name, order_id, awb_number, tracking_url
 */
async function sendOrderShipped(mobile, { customerName, orderId, awbNumber, trackingUrl }) {
  return sendTemplate(mobile, 'order_shipped', [
    customerName || 'Customer',
    orderId,
    awbNumber,
    trackingUrl
  ])
}

/**
 * Message 3 — Order delivered.
 * Template name: order_delivered
 * Variables: customer_name, order_id
 */
async function sendOrderDelivered(mobile, { customerName, orderId }) {
  return sendTemplate(mobile, 'order_delivered', [
    customerName || 'Customer',
    orderId
  ])
}

module.exports = {
  normalisePhone,
  sendOrderConfirmed,
  sendOrderShipped,
  sendOrderDelivered
}
