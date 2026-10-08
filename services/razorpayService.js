const axios = require('axios');
const crypto = require('crypto');

class RazorpayService {
  constructor({ keyId, keySecret }) {
    this.keyId = keyId || process.env.RAZORPAY_KEY_ID;
    this.keySecret = keySecret || process.env.RAZORPAY_KEY_SECRET;
    this.client = axios.create({
      baseURL: 'https://api.razorpay.com/v1',
      auth: { username: this.keyId, password: this.keySecret }, timeout: 20000
    });
  }

  async createOrder({ amountPaise, currency = 'INR', receipt, notes }) {
    const { data } = await this.client.post('/orders', {
      amount: Number(amountPaise),
      currency,
      receipt: receipt || String(Date.now()),
      payment_capture: 1,
      notes: notes || {}
    });
    return data;
  }

  async fetchPayment(id) {
    const {data}=await this.client.get(`/payments/${encodeURIComponent(id)}`);
    return data;
  }

  verifyPaymentSignature({ orderId, paymentId, signature }) {
    if (!this.keySecret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
    const hmac = crypto.createHmac('sha256', this.keySecret);
    hmac.update(`${orderId}|${paymentId}`);
    const digest = hmac.digest('hex');
    return crypto.timingSafeEqual(Buffer.from(digest,'hex'), Buffer.from(signature,'hex'));
  }

  verifyWebhookSignature({ bodyRaw, signature, secret }) {
    if (!secret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(bodyRaw);
    const digest = hmac.digest('hex');
    return crypto.timingSafeEqual(Buffer.from(digest,'hex'), Buffer.from(signature,'hex'));
  }
}

module.exports = RazorpayService;
