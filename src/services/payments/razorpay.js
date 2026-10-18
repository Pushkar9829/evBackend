// Razorpay adapter (enable with PAYMENT_PROVIDER=razorpay + keys). Uses Orders, Payments, Refunds and
// Route transfers for marketplace splits. Not exercised by the local test-suite (mock is used there).
import { config } from '../../config.js';
import { hmac, safeEqual } from '../../lib/util.js';

const base = 'https://api.razorpay.com/v1';
const auth = () => `Basic ${Buffer.from(`${config.payments.razorpayKeyId}:${config.payments.razorpayKeySecret}`).toString('base64')}`;

async function call(method, path, body) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json?.error?.description || `Razorpay ${r.status}`), { gatewayDown: r.status >= 500 });
  return json;
}

export const razorpayProvider = {
  name: 'razorpay',
  async createOrder({ amountPaise, receipt, notes, transferAccountId, tenantSharePaise }) {
    const body = { amount: amountPaise, currency: 'INR', receipt, notes, payment_capture: 1 };
    if (transferAccountId && tenantSharePaise) {
      // Razorpay Route: tenant's share transferred automatically, platform keeps commission.
      body.transfers = [{ account: transferAccountId, amount: tenantSharePaise, currency: 'INR', on_hold: 1 }];
    }
    const o = await call('POST', '/orders', body);
    return { orderId: o.id, checkout: { provider: 'razorpay', keyId: config.payments.razorpayKeyId, orderId: o.id, amount: amountPaise } };
  },
  async fetchOrder(orderId) {
    const p = await call('GET', `/orders/${orderId}/payments`);
    const captured = p.items?.find((x) => x.status === 'captured');
    const failed = p.items?.find((x) => x.status === 'failed');
    if (captured) return { status: 'paid', paymentId: captured.id, paidPaise: captured.amount, method: captured.method };
    if (failed && !p.items.some((x) => ['created', 'authorized'].includes(x.status))) return { status: 'failed', paymentId: failed.id, failureReason: failed.error_description };
    return { status: 'created' };
  },
  async refund(paymentId, amountPaise) {
    const r = await call('POST', `/payments/${paymentId}/refund`, { amount: amountPaise, speed: 'optimum' });
    return { refundId: r.id, status: r.status };
  },
  verifyWebhook(rawBody, headers) {
    const sig = headers['x-razorpay-signature'];
    if (!sig) return { ok: false, reason: 'missing signature' };
    return safeEqual(sig, hmac(config.payments.webhookSecret, rawBody)) ? { ok: true } : { ok: false, reason: 'bad signature' };
  },
  parseWebhook(body, headers = {}) {
    const p = body.payload?.payment?.entity || {};
    return {
      eventId: headers['x-razorpay-event-id'] || `${body.event}:${p.id}`,
      type: body.event,
      orderId: p.order_id,
      paymentId: p.id,
      paidPaise: p.amount,
      method: p.method,
      failureReason: p.error_description,
    };
  },
};
