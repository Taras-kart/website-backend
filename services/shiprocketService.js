const axios = require('axios');

const BASE = 'https://apiv2.shiprocket.in/v1/external';
const AUTH_BASE = process.env.SHIPROCKET_API_BASE || 'https://apiv2.shiprocket.in';

class Shiprocket {
  constructor({ pool }) {
    this.pool = pool;
    this.token = null;
  }

  async loginAndStoreToken() {
    const email = process.env.SHIPROCKET_API_USER_EMAIL;
    const password = process.env.SHIPROCKET_API_USER_PASSWORD;
    if (!email || !password) {
      throw new Error('Missing Shiprocket API creds');
    }
    const { data } = await axios.post(`${AUTH_BASE}/v1/external/auth/login`, { email, password });
    this.token = data.token;
    await this.pool.query('INSERT INTO shiprocket_accounts(token) VALUES($1)', [this.token]);
  }

  async init() {
    const { rows } = await this.pool.query('SELECT token FROM shiprocket_accounts ORDER BY id DESC LIMIT 1');
    this.token = rows[0]?.token || null;
    if (!this.token) {
      await this.loginAndStoreToken();
    }
  }

  async api(method, path, data) {
    if (!this.token) {
      await this.init();
    }
    const cfg = {
      method,
      url: `${BASE}${path}`,
      data,
      headers: { Authorization: `Bearer ${this.token}` }
    };
    try {
      return await axios(cfg);
    } catch (err) {
      const status = err.response?.status || err.status;
      if (status === 401) {
        await this.loginAndStoreToken();
        const retryCfg = {
          method,
          url: `${BASE}${path}`,
          data,
          headers: { Authorization: `Bearer ${this.token}` }
        };
        return await axios(retryCfg);
      }
      throw err;
    }
  }

  async upsertWarehouseFromBranch(branch) {
    const payload = {
      pickup_location: branch.name,
      name: branch.name,
      email: branch.email || 'support@example.com',
      phone: branch.phone || '9999999999',
      address: branch.address,
      address_2: '',
      city: branch.city,
      state: branch.state,
      country: 'India',
      pin_code: branch.pincode
    };
    const { data } = await this.api('post', '/settings/company/addpickup', payload);
    return data;
  }

  async createOrderShipment({ channel_order_id, pickup_location, order, customer }) {
    const payload = {
      order_id: channel_order_id,
      order_date: new Date().toISOString(),
      pickup_location,
      billing_customer_name: customer.name || 'Customer',
      billing_last_name: '',
      billing_address: customer.address.line1 || '',
      billing_address_2: customer.address.line2 || '',
      billing_city: customer.address.city || '',
      billing_pincode: customer.address.pincode || '',
      billing_state: customer.address.state || '',
      billing_country: 'India',
      billing_email: customer.email || 'na@example.com',
      billing_phone: customer.phone || '9999999999',
      shipping_is_billing: true,
      order_items: order.items.map((it) => ({
        name: it.name || `Variant ${it.variant_id}`,
        sku: String(it.variant_id),
        units: it.qty,
        selling_price: Number(it.price || 0)
      })),
      payment_method: order.payment_method === 'COD' ? 'COD' : 'Prepaid',
      sub_total: order.items.reduce(
        (a, it) => a + Number(it.price || 0) * Number(it.qty || 0),
        0
      ),
      length: order.dimensions?.length || 10,
      breadth: order.dimensions?.breadth || 10,
      height: order.dimensions?.height || 5,
      weight: order.weight || 0.5
    };
    const { data } = await this.api('post', '/orders/create/adhoc', payload);
    return data;
  }

  async assignAWBAndLabel({ shipment_id }) {
    const { data: awb } = await this.api('post', '/courier/assign/awb', { shipment_id });
    const { data: label } = await this.api('post', '/courier/generate/label', { shipment_id: [shipment_id] });
    return { awb, label };
  }

  async requestPickup({ shipment_id, pickup_date, status }) {
    const ids = Array.isArray(shipment_id) ? shipment_id : [shipment_id];
    const payload = { shipment_id: ids };
    if (pickup_date) {
      payload.pickup_date = Array.isArray(pickup_date) ? pickup_date : [pickup_date];
    }
    if (status) {
      payload.status = status;
    }
    const { data } = await this.api('post', '/courier/generate/pickup', payload);
    return data;
  }

  async generateManifest({ shipment_ids }) {
    const ids = Array.isArray(shipment_ids) ? shipment_ids : [shipment_ids];
    const { data } = await this.api('post', '/manifests/generate', { shipment_id: ids });
    return data;
  }
}

module.exports = Shiprocket;
