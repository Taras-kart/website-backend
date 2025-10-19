const axios = require('axios');

const BASE = 'https://apiv2.shiprocket.in/v1/external';

class Shiprocket {
  constructor({ pool }) {
    this.pool = pool;
    this.token = null;
  }

  async init() {
    const { rows } = await this.pool.query('SELECT token FROM shiprocket_accounts ORDER BY id LIMIT 1');
    this.token = rows[0]?.token || null;
    if (!this.token) throw new Error('Shiprocket token missing');
  }

  async api(method, path, data) {
    if (!this.token) await this.init();
    return axios({
      method,
      url: `${BASE}${path}`,
      data,
      headers: { Authorization: `Bearer ${this.token}` }
    });
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
      sub_total: order.items.reduce((a, it) => a + Number(it.price || 0) * Number(it.qty || 0), 0),
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
}

module.exports = Shiprocket;
