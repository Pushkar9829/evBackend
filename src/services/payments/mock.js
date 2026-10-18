// Mock payment gateway. Behaves like a hosted gateway: it has its own order state, sends signed
// webhooks, can be polled, and can be told to fail refunds — so every PAY/BIL test runs locally.
import mongoose from 'mongoose';
import { config } from '../../config.js';
import { hmac, randomId, safeEqual } from '../../lib/util.js';

const MockOrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, unique: true },
    amountPaise: Number,
    status: { type: String, enum: ['created', 'paid', 'failed', 'cancelled'], default: 'created' },
    paymentId: String,
    paidPaise: Number,
    method: String,
    failureReason: String,
    refunds: [{ refundId: String, amountPaise: Number, at: Date, _id: false }],
    notes: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true },
);
export const MockOrder = mongoose.models.MockOrder || mongoose.model('MockOrder', MockOrderSchema);

// Test / admin switches
export const mockControls = { failRefunds: 0, down: false };

export const mockProvider = {
  name: 'mock',
  async createOrder({ amountPaise, receipt, notes }) {
    if (mockControls.down) throw Object.assign(new Error('Gateway unavailable'), { gatewayDown: true });
    const orderId = `order_mock_${randomId(8)}`;
    await MockOrder.create({ orderId, amountPaise, notes: { receipt, ...notes } });
    return {
      orderId,
      checkout: {
        provider: 'mock',
        url: `${config.publicWebUrl}/pay/mock/${orderId}`,
        upiIntent: `upi://pay?pa=chargex@mockbank&pn=ChargeX&am=${(amountPaise / 100).toFixed(2)}&tr=${orderId}&cu=INR`,
      },
    };
  },
  async fetchOrder(orderId) {
    const o = await MockOrder.findOne({ orderId }).lean();
    if (!o) return null;
    return { status: o.status, paymentId: o.paymentId, paidPaise: o.paidPaise, method: o.method, failureReason: o.failureReason };
  },
  async refund(paymentId, amountPaise) {
    if (mockControls.failRefunds > 0) {
      mockControls.failRefunds -= 1;
      throw new Error('Mock gateway refused the refund');
    }
    const refundId = `rfnd_mock_${randomId(8)}`;
    await MockOrder.updateOne({ paymentId }, { $push: { refunds: { refundId, amountPaise, at: new Date() } } });
    return { refundId, status: 'processed' };
  },
  sign(rawBody, timestamp) {
    return hmac(config.payments.webhookSecret, `${timestamp}.${rawBody}`);
  },
  verifyWebhook(rawBody, headers) {
    const sig = headers['x-mock-signature'];
    const ts = Number(headers['x-mock-timestamp']);
    if (!sig || !ts) return { ok: false, reason: 'missing signature' };
    // Replay protection: reject webhooks older than 5 minutes (SEC-06)
    if (Math.abs(Date.now() / 1000 - ts) > 300) return { ok: false, reason: 'stale timestamp' };
    return safeEqual(sig, this.sign(rawBody, ts)) ? { ok: true } : { ok: false, reason: 'bad signature' };
  },
  parseWebhook(body) {
    return {
      eventId: body.id,
      type: body.event, // payment.captured | payment.failed
      orderId: body.payload?.order_id,
      paymentId: body.payload?.payment_id,
      paidPaise: body.payload?.amount,
      method: body.payload?.method,
      failureReason: body.payload?.error_description,
    };
  },
};

/** Build a signed webhook as the mock gateway would send it. */
export function buildMockWebhook({ event, orderId, paymentId, amount, method = 'upi', error, id = `evt_${randomId(8)}`, timestamp = Math.floor(Date.now() / 1000) }) {
  const body = JSON.stringify({ id, event, payload: { order_id: orderId, payment_id: paymentId, amount, method, error_description: error } });
  return { body, headers: { 'content-type': 'application/json', 'x-mock-signature': mockProvider.sign(body, timestamp), 'x-mock-timestamp': String(timestamp) } };
}
