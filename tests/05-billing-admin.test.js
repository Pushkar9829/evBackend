// Billing, refunds, invoices (2.8), notifications (2.9) and admin control guardrails (Part 3).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, sim, guestSession, sessionDoc, waitFor, staffToken, sleep } from './helpers.js';
import { Approval, AuditLog, Charger, ChargerModel, Invoice, Notification, Payout, Refund, Session, Tenant, nextSeq } from '../src/models/index.js';
import { computeBill } from '../src/services/tariffs.js';
import { mockControls } from '../src/services/payments/mock.js';
import { retryDueRefunds } from '../src/services/refunds.js';
import { retryFailedInvoices, issueSessionInvoice } from '../src/services/invoices.js';
import { reconcile, buildPayout } from '../src/services/finance.js';
import { notify } from '../src/services/notifications.js';
import { gstOn } from '../src/lib/money.js';

let api;
let c;
let owner;
let agent;
let admin;
let finance;
before(async () => {
  ({ api } = await boot());
  c = await sim('VG-PUN-001');
  await c.plugIn(2);
  owner = await staffToken('owner@voltgrid.in');
  agent = await staffToken('help@voltgrid.in');
  admin = await staffToken('admin@chargex.in');
  finance = await staffToken('finance@chargex.in');
});
after(shutdown);

const auth = (t) => ({ Authorization: `Bearer ${t}` });
async function billed(amountPaise = 20000, ticks = 2) {
  const s = await guestSession({ ocppId: 'VG-PUN-001', connector: 2, amountPaise });
  await waitFor(async () => (await sessionDoc(s.sessionId)).state === 'CHARGING', { label: 'charging' });
  for (let i = 0; i < ticks; i += 1) await c.tick();
  await api.post(`/api/sessions/${s.sessionId}/stop`).set('x-session-token', s.accessToken);
  await waitFor(async () => (await sessionDoc(s.sessionId)).invoice || ((await sessionDoc(s.sessionId)).state === 'BILLED' && (await sessionDoc(s.sessionId)).costs.totalPaise === 0), { label: 'billed' });
  return { ...s, doc: await sessionDoc(s.sessionId) };
}

describe('2.8 billing, refunds and invoices', () => {
  it('BIL-02/03/04 small energy, paise rounding and per-line GST reconcile exactly', () => {
    const t = { energyPaisePerKwh: 1800, sessionFeePaise: 1000, gstRateBps: 1800 };
    const b = computeBill({ tariff: t, energyWh: 50, costs: { energyExact: 90 }, startedAt: new Date(), endedAt: new Date() });
    assert.equal(b.lines.find((l) => l.code === 'energy').taxablePaise, 90);
    assert.equal(b.lines.reduce((s, l) => s + l.totalPaise, 0), b.totalPaise);
    assert.equal(b.taxablePaise + b.gstPaise, b.totalPaise);
    assert.equal(b.gstPaise, gstOn(90) + gstOn(1000));
    const capped = computeBill({ tariff: t, energyWh: 50_000, costs: { energyExact: 90_000 }, capPaise: 20000 });
    assert.equal(capped.totalPaise, 20000);
    assert.equal(capped.taxablePaise + capped.gstPaise, 20000);
    assert.ok(capped.absorbedPaise > 0);
  });

  it('BIL-05 refund failing at the gateway: retried with backoff, after 3 failures finance queue + driver informed', async () => {
    mockControls.failRefunds = 3;
    const s = await billed();
    const r1 = await Refund.findOne({ session: s.sessionId });
    assert.equal(r1.status, 'failed');
    for (let i = 0; i < 2; i += 1) {
      await Refund.updateOne({ _id: r1._id }, { $set: { nextAttemptAt: new Date() } });
      await retryDueRefunds();
    }
    const r3 = await Refund.findById(r1._id);
    assert.equal(r3.status, 'finance_queue');
    assert.equal(r3.attempts, 3);
    assert.ok(await Notification.exists({ session: s.sessionId, template: 'refund_delayed' }));
    // Finance retries from the queue
    const fin = await api.post(`/api/cms/refunds/${r1._id}/retry`).set(auth(owner));
    assert.equal(fin.status, 200);
    assert.equal(fin.body.refund.status, 'succeeded');
  });

  it('BIL-06 admin partial refund cannot exceed the amount paid, needs a reason, is audit-logged', async () => {
    const s = await billed();
    const noReason = await api.post(`/api/cms/sessions/${s.sessionId}/refund`).set(auth(owner)).send({ amountPaise: 100 });
    assert.equal(noReason.status, 400);
    const tooMuch = await api.post(`/api/cms/sessions/${s.sessionId}/refund`).set(auth(owner)).send({ amountPaise: 999999, reason: 'complaint' });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.body.error.code, 'REFUND_EXCEEDS_PAID');
    const ok = await api.post(`/api/cms/sessions/${s.sessionId}/refund`).set(auth(owner)).send({ amountPaise: 500, reason: 'goodwill' });
    assert.equal(ok.status, 200);
    assert.ok(await AuditLog.exists({ action: 'session.refund', entityId: s.sessionId }));
  });

  it('SEC-08 refund above the support agent limit goes to approval (maker-checker, no self-approval)', async () => {
    const { ROLES } = await import('../src/lib/permissions.js');
    const original = ROLES.support_agent.refundLimitPaise;
    ROLES.support_agent.refundLimitPaise = 100; // Rs 1 for the test
    try {
      const s = await billed();
      const small = await api.post(`/api/cms/sessions/${s.sessionId}/refund`).set(auth(agent)).send({ amountPaise: 100, reason: 'goodwill' });
      assert.equal(small.status, 200, 'within limit: refunded directly');
      const big = await api.post(`/api/cms/sessions/${s.sessionId}/refund`).set(auth(agent)).send({ amountPaise: 200, reason: 'overcharged' });
      assert.equal(big.status, 202);
      assert.equal(big.body.status, 'PendingApproval');
      const self = await api.post(`/api/cms/approvals/${big.body.approvalId}/decide`).set(auth(owner)).send({ approve: false });
      assert.equal(self.status, 200, 'another person can reject');
      const again = await api.post(`/api/cms/sessions/${s.sessionId}/refund`).set(auth(agent)).send({ amountPaise: 200, reason: 'overcharged' });
      const mine = await api.post(`/api/cms/approvals/${again.body.approvalId}/decide`).set(auth(agent)).send({ approve: true });
      assert.equal(mine.status, 403, 'agent has no approval right / cannot self-approve');
      const dec = await api.post(`/api/cms/approvals/${again.body.approvalId}/decide`).set(auth(owner)).send({ approve: true });
      assert.equal(dec.body.approval.status, 'executed');
      assert.equal(await Refund.countDocuments({ session: s.sessionId, kind: 'admin' }), 2);
    } finally {
      ROLES.support_agent.refundLimitPaise = original;
    }
  });

  it('BIL-07 invoice generation fails: session still completed; invoice retried later', async () => {
    process.env.FAIL_INVOICES = '1';
    const s = await guestSession({ ocppId: 'VG-PUN-001', connector: 2 });
    await waitFor(async () => (await sessionDoc(s.sessionId)).state === 'CHARGING', { label: 'charging' });
    await c.tick();
    await api.post(`/api/sessions/${s.sessionId}/stop`).set('x-session-token', s.accessToken);
    await waitFor(async () => (await Invoice.findOne({ session: s.sessionId }))?.status === 'failed', { label: 'invoice failed' });
    assert.equal((await sessionDoc(s.sessionId)).state, 'BILLED');
    delete process.env.FAIL_INVOICES;
    await retryFailedInvoices();
    const inv = await Invoice.findOne({ session: s.sessionId });
    assert.equal(inv.status, 'issued');
    assert.ok(inv.number);
  });

  it('BIL-10 invoice numbers are sequential with no gaps or duplicates under concurrency', async () => {
    const seqs = await Promise.all(Array.from({ length: 40 }, () => nextSeq('concurrency-test')));
    const sorted = [...seqs].sort((a, b) => a - b);
    assert.deepEqual(sorted, Array.from({ length: 40 }, (_, i) => i + 1));
    const nums = (await Invoice.find({ kind: 'driver', status: 'issued' }).select('number').lean()).map((i) => i.number);
    assert.equal(new Set(nums).size, nums.length);
  });

  it('GSTIN correction: credit note + new invoice, never an edit', async () => {
    const s = await billed();
    const inv = await Invoice.findById(s.doc.invoice);
    const r = await api.post(`/api/cms/invoices/${inv._id}/correct-gstin`).set(auth(owner)).send({ gstin: '27AAPFU0939F1ZV', buyerName: 'Acme Logistics', reason: 'driver request' });
    assert.equal(r.status, 200);
    assert.equal(r.body.creditNote.totalPaise, -inv.totalPaise);
    assert.equal((await Invoice.findById(inv._id)).status, 'cancelled');
    assert.equal(r.body.invoice.buyer.gstin, '27AAPFU0939F1ZV');
  });

  it('BIL-11 daily reconciliation flags mismatches with the list', async () => {
    const s = await billed();
    await Session.updateOne({ _id: s.sessionId }, { $set: { 'costs.totalPaise': s.doc.costs.totalPaise + 1 } });
    const run = await reconcile(new Date());
    assert.equal(run.status, 'mismatch');
    assert.ok(run.mismatches.some((m) => m.kind === 'amount'));
    await Session.updateOne({ _id: s.sessionId }, { $set: { 'costs.totalPaise': s.doc.costs.totalPaise } });
  });

  it('BIL-12 tenant payout = share of completed sessions - refunds - commission (+GST on commission)', async () => {
    const vg = await Tenant.findOne({ slug: 'voltgrid' });
    await Tenant.updateOne({ _id: vg._id }, { $set: { payoutDelayDays: 0 } });
    const p = await buildPayout(vg._id);
    assert.ok(p.sessionCount > 0);
    assert.equal(p.netPaise, p.grossPaise - p.commissionPaise - p.gstOnCommissionPaise - p.siteHostSharePaise + p.adjustmentsPaise);
    const sum = p.lines.reduce((s, l) => s + l.totalPaise, 0);
    assert.equal(sum, p.grossPaise, 'statement matches');
    assert.ok(p.commissionInvoice, 'commission invoice issued');
    assert.equal(await Session.countDocuments({ settledInPayout: p._id }), p.sessionCount);
  });
});

describe('2.9 notifications', () => {
  it('NOT-01 push disabled: critical messages fall back to SMS', async () => {
    const s = await billed();
    assert.ok(await Notification.exists({ session: s.sessionId, channel: 'sms', template: 'session_completed' }));
  });

  it('NOT-03 "Started" never arrives after "Completed"', async () => {
    const s = await billed();
    const done = await Notification.findOne({ session: s.sessionId, template: 'session_completed' });
    await Notification.deleteMany({ session: s.sessionId, template: 'session_started' });
    const r = await notify('session_started', { phone: '9123456789', session: s.sessionId, eventAt: new Date(done.eventAt.getTime() - 60_000) });
    assert.equal(r.suppressed, true);
  });
});

describe('Part 3 admin control', () => {
  it('commission changes need a second approval (platform)', async () => {
    const vg = await Tenant.findOne({ slug: 'voltgrid' });
    const r = await api.post('/api/admin/commission').set(auth(admin)).send({ tenant: String(vg._id), kind: 'percent', value: 800, effectiveFrom: new Date().toISOString(), reason: 'new plan' });
    assert.equal(r.status, 202);
    const tenantTry = await api.post(`/api/cms/approvals/${r.body.approvalId}/decide`).set(auth(owner)).send({ approve: true });
    assert.equal(tenantTry.status, 403, 'tenant cannot approve platform money changes');
    const ok = await api.post(`/api/cms/approvals/${r.body.approvalId}/decide`).set(auth(finance)).send({ approve: true });
    assert.equal(ok.body.approval.status, 'executed');
  });

  it('suspending a tenant hides its chargers; data kept', async () => {
    const gp = await Tenant.findOne({ slug: 'greenplug' });
    await api.post(`/api/admin/tenants/${gp._id}/status`).set(auth(admin)).send({ status: 'suspended', reason: 'unpaid dues' }).expect(200);
    const list = await api.get('/api/public/chargers?available=false');
    assert.ok(!list.body.chargers.some((x) => x.ocppId === 'GP-BLR-001'));
    assert.ok(await Charger.exists({ ocppId: 'GP-BLR-001' }));
    await api.post(`/api/admin/tenants/${gp._id}/status`).set(auth(admin)).send({ status: 'active', reason: 'paid' }).expect(200);
  });

  it('disable a charger model / firmware: starts blocked on those chargers', async () => {
    const ch = await Charger.findOne({ ocppId: 'VG-PUN-001' });
    await api.put('/api/admin/models').set(auth(admin)).send({ vendor: ch.vendor, model: ch.model, blockedFirmware: [ch.firmware], reason: 'bad firmware' }).expect(200);
    const r = await api.post('/api/sessions').send({ ocppId: 'VG-PUN-001', connector: 2, amountPaise: 10000, phone: '9123000000' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'MODEL_BLOCKED');
    await ChargerModel.deleteMany({});
  });

  it('command centre: reset warns when a session is active; availability hides it from the app', async () => {
    const s = await guestSession({ ocppId: 'VG-PUN-001', connector: 2 });
    await waitFor(async () => (await sessionDoc(s.sessionId)).state === 'CHARGING', { label: 'charging' });
    const ch = await Charger.findOne({ ocppId: 'VG-PUN-001' });
    const tech = await staffToken('tech@voltgrid.in');
    const warn = await api.post(`/api/cms/chargers/${ch._id}/commands`).set(auth(tech)).send({ action: 'reset', type: 'soft' });
    assert.equal(warn.status, 409);
    assert.equal(warn.body.error.code, 'SESSION_ACTIVE');
    await api.post(`/api/sessions/${s.sessionId}/stop`).set('x-session-token', s.accessToken);
    await waitFor(async () => (await sessionDoc(s.sessionId)).state === 'BILLED', { label: 'billed' });
    const off = await api.post(`/api/cms/chargers/${ch._id}/commands`).set(auth(tech)).send({ action: 'availability', operative: false, reason: 'maintenance' });
    assert.equal(off.body.status, 'Accepted');
    const qr = await api.get('/api/public/qr/VG-PUN-001/2');
    assert.equal(qr.status, 404);
    await api.post(`/api/cms/chargers/${ch._id}/commands`).set(auth(tech)).send({ action: 'availability', operative: true, reason: 'done' });
    const tech2 = await api.post(`/api/cms/sessions/${s.sessionId}/refund`).set(auth(tech)).send({ amountPaise: 100, reason: 'x' });
    assert.equal(tech2.status, 403, 'technician cannot refund');
  });

  it('critical config keys need approval before they are sent', async () => {
    const ch = await Charger.findOne({ ocppId: 'VG-PUN-001' });
    const ops = await staffToken('ops@voltgrid.in');
    const r = await api.post(`/api/cms/chargers/${ch._id}/commands`).set(auth(ops)).send({ action: 'set_config', key: 'SecurityProfile', value: '3', reason: 'upgrade' });
    assert.equal(r.body.status, 'PendingApproval');
    const normal = await api.post(`/api/cms/chargers/${ch._id}/commands`).set(auth(ops)).send({ action: 'set_config', key: 'HeartbeatInterval', value: '120' });
    assert.equal(normal.body.status, 'Accepted');
    assert.equal(c.configuration.HeartbeatInterval, '120');
    const dec = await api.post(`/api/cms/approvals/${r.body.approvalId}/decide`).set(auth(owner)).send({ approve: true });
    assert.equal(dec.body.approval.status, 'executed');
    assert.equal(c.configuration.SecurityProfile, '3');
  });

  it('global search finds sessions by phone, chargers by id and invoices by number', async () => {
    const inv = await Invoice.findOne({ status: 'issued', kind: 'driver' });
    const r1 = await api.get('/api/admin/search').query({ q: '9123456789' }).set(auth(admin));
    assert.ok(r1.body.sessions.length > 0);
    const r2 = await api.get('/api/admin/search').query({ q: 'VG-PUN' }).set(auth(admin));
    assert.ok(r2.body.chargers.length >= 2);
    const r3 = await api.get('/api/admin/search').query({ q: inv.number }).set(auth(admin));
    assert.equal(r3.body.invoices[0].number, inv.number);
  });

  it('health panel reports gateway connections, success rate and queues', async () => {
    const r = await api.get('/api/admin/health').set(auth(admin)).expect(200);
    assert.ok(r.body.gateway.connections >= 1);
    assert.ok('paymentSuccessRatePct' in r.body.lastHour);
  });

  it('payout hold needs maker-checker', async () => {
    const p = await Payout.findOne({ status: { $in: ['released', 'draft'] } });
    if (!p) return;
    const r = await api.post(`/api/admin/payouts/${p._id}/hold`).set(auth(admin)).send({ hold: true, reason: 'dispute' });
    assert.equal(r.status, 202);
    assert.equal((await Approval.findById(r.body.approvalId)).type, 'payout_hold');
    await api.post(`/api/cms/approvals/${r.body.approvalId}/decide`).set(auth(finance)).send({ approve: true }).expect(200);
    assert.equal((await Payout.findById(p._id)).status, 'held');
  });

  it('view as driver is logged', async () => {
    const s = await Session.findOne({ state: 'BILLED' });
    await api.get(`/api/cms/sessions/${s._id}/as-driver`).set(auth(owner)).expect(200);
    assert.ok(await AuditLog.exists({ action: 'session.view_as_driver', entityId: String(s._id) }));
  });

  it('versioned tariffs: publish needs a reason; preview cost before publishing', async () => {
    const r = await api.post('/api/cms/tariffs').set(auth(owner)).send({ key: 'night', name: 'Night saver', energyPaisePerKwh: 1400 });
    assert.equal(r.status, 201);
    assert.equal(r.body.preview.length, 4);
    const noReason = await api.post(`/api/cms/tariffs/${r.body.tariff._id}/publish`).set(auth(owner)).send({});
    assert.equal(noReason.status, 400);
    const ok = await api.post(`/api/cms/tariffs/${r.body.tariff._id}/publish`).set(auth(owner)).send({ reason: 'launch' });
    assert.equal(ok.body.tariff.status, 'published');
  });

});
