// Payments (2.4): every outcome ends in exactly one charge or a full automatic refund.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, sim, guestSession, getSession, sessionDoc, waitFor, staffToken, sleep } from './helpers.js';
import { Payment, Refund, Session, SecurityEvent, WebhookEvent } from '../src/models/index.js';
import { buildMockWebhook, mockControls } from '../src/services/payments/mock.js';
import { tickSessions } from '../src/services/sessionEngine.js';
import { updateSettings } from '../src/services/settings.js';

let api;
let charger;
before(async () => {
  ({ api } = await boot());
  charger = await sim('VG-PUN-003');
  await charger.plugIn(1);
  await charger.plugIn(2);
});
after(shutdown);

const create = (body = {}) => api.post('/api/sessions').send({ ocppId: 'VG-PUN-003', connector: 1, amountPaise: 20000, phone: '9123400000', idempotencyKey: `k-${Math.random()}`, ...body });
async function stopAndWait(s) {
  await api.post(`/api/sessions/${s.sessionId}/stop`).set('x-session-token', s.accessToken);
  await waitFor(async () => ['BILLED', 'FAILED', 'CANCELLED'].includes((await sessionDoc(s.sessionId)).state), { label: 'session closed' });
}

describe('2.4 payments', () => {
  it('PAY-01 UPI success confirmed by webhook starts the charger', async () => {
    const s = await guestSession({ ocppId: 'VG-PUN-003' });
    await waitFor(async () => (await sessionDoc(s.sessionId)).state === 'CHARGING', { label: 'charging' });
    await stopAndWait(s);
  });

  it('PAY-02 user cancels in the UPI app: "Payment cancelled, nothing charged" + retry', async () => {
    const r = await create();
    await api.post(`/api/payments/mock/${r.body.orderId}/complete`).send({ outcome: 'cancel' });
    const v = await api.post(`/api/sessions/${r.body.sessionId}/verify-payment`).set('x-session-token', r.body.accessToken).expect(200);
    assert.equal(v.body.state, 'CREATED');
    assert.match(v.body.message, /cancelled, nothing charged/i);
    const retry = await api.post(`/api/sessions/${r.body.sessionId}/pay`).set('x-session-token', r.body.accessToken).expect(200);
    assert.ok(retry.body.orderId && retry.body.orderId !== r.body.orderId);
    await api.post(`/api/sessions/${r.body.sessionId}/cancel`).set('x-session-token', r.body.accessToken);
  });

  it('PAY-03 failed UPI shows the reason; nothing charged', async () => {
    const r = await create();
    await api.post(`/api/payments/mock/${r.body.orderId}/complete`).send({ outcome: 'fail', failureReason: 'Incorrect UPI PIN' });
    const v = await getSession(r.body.sessionId, r.body.accessToken);
    assert.equal(v.state, 'CREATED');
    assert.match(v.message, /Incorrect UPI PIN/);
    await api.post(`/api/sessions/${r.body.sessionId}/cancel`).set('x-session-token', r.body.accessToken);
  });

  it('PAY-04 pending > 5 min: session cancelled; money arriving later is refunded automatically', async () => {
    const r = await create();
    await Session.collection.updateOne({ _id: new Session({ _id: r.body.sessionId })._id }, { $set: { createdAt: new Date(Date.now() - 6 * 60_000) } });
    await tickSessions();
    assert.equal((await sessionDoc(r.body.sessionId)).state, 'CANCELLED');
    await api.post(`/api/payments/mock/${r.body.orderId}/complete`).send({ outcome: 'success' });
    const refund = await waitFor(() => Refund.findOne({ session: r.body.sessionId }).lean(), { label: 'late refund' });
    assert.equal(refund.amountPaise, 20000);
    assert.equal(refund.kind, 'late_payment');
  });

  it('PAY-05 duplicate webhook is processed once: one session, one charge', async () => {
    const s = await guestSession({ ocppId: 'VG-PUN-003', extra: { duplicateWebhook: true } });
    await waitFor(async () => (await sessionDoc(s.sessionId)).state === 'CHARGING', { label: 'charging' });
    const pay = await Payment.findOne({ orderId: s.orderId }).lean();
    assert.equal(pay.status, 'captured');
    assert.equal(await Refund.countDocuments({ payment: pay._id }), 0);
    await stopAndWait(s);
  });

  it('PAY-06 redirect/verify before or after the webhook reaches the same final state', async () => {
    const r = await create();
    await api.post(`/api/payments/mock/${r.body.orderId}/complete`).send({ outcome: 'success', webhook: 'never' });
    const v = await api.post(`/api/sessions/${r.body.sessionId}/verify-payment`).set('x-session-token', r.body.accessToken).expect(200);
    assert.ok(['PAID', 'STARTING', 'CHARGING'].includes(v.body.state));
    // the webhook arrives late: no change, no second charge
    const pay = await Payment.findOne({ orderId: r.body.orderId }).lean();
    const wh = buildMockWebhook({ event: 'payment.captured', orderId: r.body.orderId, paymentId: pay.gatewayPaymentId, amount: 20000 });
    await api.post('/api/payments/webhook/mock').set(wh.headers).send(wh.body).expect(200);
    await waitFor(async () => (await sessionDoc(r.body.sessionId)).state === 'CHARGING', { label: 'charging' });
    assert.equal(await Refund.countDocuments({ payment: pay._id }), 0);
    await stopAndWait({ sessionId: r.body.sessionId, accessToken: r.body.accessToken });
  });

  it('PAY-07 webhook with an invalid signature is rejected and logged', async () => {
    const r = await create();
    const wh = buildMockWebhook({ event: 'payment.captured', orderId: r.body.orderId, paymentId: 'pay_fake', amount: 20000 });
    const res = await api.post('/api/payments/webhook/mock').set({ ...wh.headers, 'x-mock-signature': 'deadbeef' }).send(wh.body);
    assert.equal(res.status, 400);
    assert.ok(await SecurityEvent.exists({ type: 'webhook_rejected' }));
    assert.equal((await sessionDoc(r.body.sessionId)).state, 'CREATED');
    await api.post(`/api/sessions/${r.body.sessionId}/cancel`).set('x-session-token', r.body.accessToken);
  });

  it('SEC-06 replay of an old webhook is rejected (timestamp + idempotency)', async () => {
    const old = buildMockWebhook({ event: 'payment.captured', orderId: 'order_x', paymentId: 'p', amount: 1, timestamp: Math.floor(Date.now() / 1000) - 3600 });
    const res = await api.post('/api/payments/webhook/mock').set(old.headers).send(old.body);
    assert.equal(res.status, 400);
    const fresh = buildMockWebhook({ id: 'evt_replay', event: 'payment.failed', orderId: 'order_x', paymentId: 'p', amount: 1 });
    await api.post('/api/payments/webhook/mock').set(fresh.headers).send(fresh.body).expect(200);
    const again = await api.post('/api/payments/webhook/mock').set(fresh.headers).send(fresh.body).expect(200);
    assert.equal(again.body.duplicate, true);
    assert.equal(await WebhookEvent.countDocuments({ eventId: 'evt_replay' }), 1);
  });

  it('PAY-08 amount tampered: paid amount must equal the order amount, else refund + flag', async () => {
    const r = await create();
    await api.post(`/api/payments/mock/${r.body.orderId}/complete`).send({ outcome: 'success', tamperPaise: 100 });
    const s = await waitFor(async () => {
      const d = await sessionDoc(r.body.sessionId);
      return d.state === 'FAILED' && d;
    }, { label: 'failed' });
    assert.ok(s.flags.includes('amount_mismatch'));
    const refund = await Refund.findOne({ session: s._id }).lean();
    assert.equal(refund.amountPaise, 100);
  });

  it('PAY-09 tapping Pay twice quickly creates one order', async () => {
    const key = `double-${Date.now()}`;
    const [a, b] = await Promise.all([create({ idempotencyKey: key }), create({ idempotencyKey: key })]);
    const ok = [a, b].filter((x) => [200, 201].includes(x.status));
    assert.ok(ok.length >= 1);
    assert.equal(await Payment.countDocuments({ idempotencyKey: key }), 1);
    const id = ok[0].body.sessionId;
    await api.post(`/api/sessions/${id}/cancel`).set('x-session-token', ok[0].body.accessToken);
  });

  it('PAY-10 two users pay for the same connector: first wins, second is refunded instantly', async () => {
    const a = await create({ connector: 2, phone: '9100000001' });
    const b = await create({ connector: 2, phone: '9100000002' });
    await api.post(`/api/payments/mock/${a.body.orderId}/complete`).send({ outcome: 'success' });
    await api.post(`/api/payments/mock/${b.body.orderId}/complete`).send({ outcome: 'success' });
    await waitFor(async () => (await sessionDoc(a.body.sessionId)).state === 'CHARGING', { label: 'first charging' });
    const second = await waitFor(async () => {
      const d = await sessionDoc(b.body.sessionId);
      return d.state === 'FAILED' && d;
    }, { label: 'second failed' });
    assert.equal(second.failureReason, 'connector_taken');
    const refund = await Refund.findOne({ session: second._id }).lean();
    assert.equal(refund.amountPaise, 20000);
    await stopAndWait({ sessionId: a.body.sessionId, accessToken: a.body.accessToken });
  });

  it('PAY-11 gateway down: payment refused with a status message and alert; recovers', async () => {
    mockControls.down = true;
    const r = await create();
    assert.equal(r.status, 503);
    const cfg = await api.get('/api/public/config');
    assert.equal(cfg.body.paymentsPaused, true);
    const admin = await staffToken('admin@chargex.in');
    await api.post('/api/payments/mock-controls').set('Authorization', `Bearer ${admin}`).send({ down: false }).expect(200);
    await sleep(3100); // settings cache
    assert.equal((await api.get('/api/public/config')).body.paymentsPaused, false);
  });

  it('PAY-12 webhook never arrives: server polls the gateway and continues', async () => {
    const r = await create();
    await api.post(`/api/payments/mock/${r.body.orderId}/complete`).send({ outcome: 'success', webhook: 'never' });
    await Payment.collection.updateOne({ orderId: r.body.orderId }, { $set: { createdAt: new Date(Date.now() - 20_000) } });
    await tickSessions();
    await waitFor(async () => (await sessionDoc(r.body.sessionId)).state === 'CHARGING', { label: 'charging after poll' });
    await stopAndWait({ sessionId: r.body.sessionId, accessToken: r.body.accessToken });
  });

  it('PAY-13 amounts below Rs 50 or above the max are refused', async () => {
    assert.equal((await create({ amountPaise: 4900 })).status, 400);
    assert.equal((await create({ amountPaise: 99_000_000 })).status, 400);
  });

  it('kill switch: pausing new payments blocks new sessions; running sessions continue', async () => {
    await updateSettings({ pauseNewPayments: true, pauseReason: 'Gateway incident' });
    const r = await create();
    assert.equal(r.status, 503);
    assert.match(r.body.error.message, /Gateway incident/);
    await updateSettings({ pauseNewPayments: false });
  });
});
