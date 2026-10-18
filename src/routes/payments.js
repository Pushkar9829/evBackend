import express from 'express';
import { Payment, WebhookEvent } from '../models/index.js';
import { config } from '../config.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { randomId } from '../lib/util.js';
import { parse, z } from '../lib/validate.js';
import { provider } from '../services/payments/index.js';
import { MockOrder, buildMockWebhook, mockControls, mockProvider } from '../services/payments/mock.js';
import { onPaymentResult } from '../services/sessionEngine.js';
import { securityEvent } from '../services/audit.js';
import { requireStaff, can } from '../middleware/auth.js';
import { updateSettings } from '../services/settings.js';
import { resolveAlerts } from '../services/alerts.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

/**
 * Process a webhook body. Signature (PAY-07), replay window + idempotency (PAY-05, SEC-06).
 * Exported so the mock gateway can dispatch real signed webhooks through the same path.
 */
export async function handleWebhook(providerName, rawBody, headers, ip) {
  const p = providerName === 'mock' ? mockProvider : provider();
  const v = p.verifyWebhook(rawBody, headers);
  if (!v.ok) {
    await securityEvent('webhook_rejected', { provider: providerName, reason: v.reason }, ip);
    throw new AppError(400, 'BAD_SIGNATURE', 'Invalid webhook signature');
  }
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw badRequest('BAD_JSON', 'Invalid JSON');
  }
  const evt = p.parseWebhook(body, headers);
  try {
    await WebhookEvent.create({ eventId: evt.eventId, provider: providerName, type: evt.type });
  } catch (e) {
    if (e.code === 11000) return { duplicate: true };
    throw e;
  }
  const status = /captured|paid/.test(evt.type) ? 'paid' : /failed/.test(evt.type) ? 'failed' : null;
  if (!status) return { ignored: true };
  return onPaymentResult({ orderId: evt.orderId, status, gatewayPaymentId: evt.paymentId, paidPaise: evt.paidPaise, method: evt.method, failureReason: evt.failureReason });
}

router.post('/webhook/:provider', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});
  const r = await handleWebhook(req.params.provider, raw, req.headers, req.ip);
  res.json({ ok: true, ...r });
});

// ------------------------------------------------------------- mock gateway (development / QA)

const mockOnly = (_req, _res, next) => (config.payments.provider === 'mock' ? next() : next(notFound()));

router.get('/mock/:orderId', mockOnly, async (req, res) => {
  const o = await MockOrder.findOne({ orderId: req.params.orderId }).lean();
  if (!o) throw notFound('Order not found.');
  const pay = await Payment.findOne({ orderId: o.orderId }).select('session').lean();
  res.json({ orderId: o.orderId, amountPaise: o.amountPaise, status: o.status, sessionId: pay?.session, down: mockControls.down });
});

/**
 * Simulate what the payer does in their UPI app.
 * outcome: success | fail | cancel; webhook: send now (default) / delay ms / never (PAY-12);
 * duplicateWebhook (PAY-05); tamperPaise (PAY-08).
 */
router.post('/mock/:orderId/complete', express.json(), mockOnly, async (req, res) => {
  const b = parse(z.object({
    outcome: z.enum(['success', 'fail', 'cancel']),
    method: z.string().default('upi'),
    failureReason: z.string().optional(),
    webhook: z.union([z.literal('now'), z.literal('never'), z.number().int().nonnegative()]).default('now'),
    duplicateWebhook: z.boolean().default(false),
    tamperPaise: z.number().int().positive().optional(),
  }), req.body);
  const o = await MockOrder.findOne({ orderId: req.params.orderId });
  if (!o) throw notFound('Order not found.');
  if (o.status !== 'created') return res.json({ status: o.status, already: true });
  if (b.outcome === 'cancel') {
    o.status = 'cancelled';
    await o.save();
    return res.json({ status: 'cancelled' });
  }
  o.paymentId = `pay_mock_${randomId(8)}`;
  o.method = b.method;
  if (b.outcome === 'success') {
    o.status = 'paid';
    o.paidPaise = b.tamperPaise || o.amountPaise;
  } else {
    o.status = 'failed';
    o.failureReason = b.failureReason || 'Insufficient balance';
  }
  await o.save();
  const wh = buildMockWebhook({ event: o.status === 'paid' ? 'payment.captured' : 'payment.failed', orderId: o.orderId, paymentId: o.paymentId, amount: o.paidPaise, method: o.method, error: o.failureReason });
  const dispatch = () => handleWebhook('mock', wh.body, wh.headers, '127.0.0.1').catch((e) => logger.error('mock webhook', e));
  if (b.webhook === 'now') {
    await dispatch();
    if (b.duplicateWebhook) await dispatch();
  } else if (typeof b.webhook === 'number') setTimeout(dispatch, b.webhook);
  return res.json({ status: o.status, paymentId: o.paymentId });
});

router.post('/mock-controls', express.json(), requireStaff, can('simulator.use', 'platform.switches'), async (req, res) => {
  const b = parse(z.object({ failRefunds: z.number().int().min(0).max(10).optional(), down: z.boolean().optional() }), req.body);
  if (b.failRefunds !== undefined) mockControls.failRefunds = b.failRefunds;
  if (b.down !== undefined) {
    mockControls.down = b.down;
    if (!b.down) {
      await updateSettings({ gatewayDown: false });
      await resolveAlerts({ dedupeKey: 'gateway_down' });
    }
  }
  res.json(mockControls);
});

export default router;
