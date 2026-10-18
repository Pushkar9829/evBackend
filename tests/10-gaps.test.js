// Gap fixes: white-label gating, fleet monthly invoices, SaaS plan fee, alert delivery, spot reports,
// site-host revenue share, meter graph points, translatable session messages.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, sim, guestSession, sessionDoc, waitFor, staffToken, driverToken } from './helpers.js';
import { Adjustment, Alert, Complaint, Fleet, Invoice, Session, Site, Tenant, User } from '../src/models/index.js';
import { runMonthlyBilling } from '../src/services/monthlyBilling.js';
import { buildPayout } from '../src/services/finance.js';
import { raiseAlert } from '../src/services/alerts.js';

let api;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const thisMonth = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
before(async () => {
  ({ api } = await boot());
});
after(shutdown);

describe('white-label', () => {
  it('branding is served only to tenants with the white_label add-on; QR pages carry it', async () => {
    const vg = await api.get('/api/public/branding/voltgrid').expect(200);
    assert.equal(vg.body.name, 'VoltGo');
    assert.equal(vg.body.primaryColor, '#2563eb');
    await api.get('/api/public/branding/greenplug').expect(404);
    await sim('VG-PUN-002');
    const qr = await api.get('/api/public/qr/VG-PUN-002/1').expect(200);
    assert.equal(qr.body.branding.name, 'VoltGo');
    const owner = await staffToken('owner@voltgrid.in');
    const me = await api.get('/api/auth/me').set(auth(owner)).expect(200);
    assert.equal(me.body.branding.primaryColor, '#2563eb');
  });
});

describe('fleet monthly invoice and SaaS plan fee', () => {
  it('fleet sessions skip per-session invoices and land on one monthly invoice per operator', async () => {
    const mgr = await driverToken('9600000001');
    await api.post('/api/me/fleet').set(auth(mgr)).send({ name: 'Metro Cabs', gstin: '27AABCM1234F1Z5' }).expect(201);
    await api.post('/api/me/fleet/drivers').set(auth(mgr)).send({ phone: '9600000002', spendLimitPaise: 100000 }).expect(201);
    const drv = await driverToken('9600000002');
    const c = await sim('VG-PUN-001');
    await c.plugIn(2);
    const ids = [];
    for (let i = 0; i < 2; i += 1) {
      const r = await api.post('/api/sessions').set(auth(drv)).send({ ocppId: 'VG-PUN-001', connector: 2, fleet: true }).expect(201);
      await waitFor(async () => (await sessionDoc(r.body.sessionId)).state === 'CHARGING', { label: 'charging' });
      await c.tick();
      await api.post(`/api/sessions/${r.body.sessionId}/stop`).set(auth(drv));
      await waitFor(async () => (await sessionDoc(r.body.sessionId)).state === 'BILLED', { label: 'billed' });
      ids.push(r.body.sessionId);
    }
    assert.equal(await Invoice.countDocuments({ session: { $in: ids } }), 0, 'no per-session invoices for fleet');
    const r = await runMonthlyBilling(thisMonth());
    assert.equal(r.fleetInvoices, 1);
    const inv = await Invoice.findOne({ kind: 'fleet_monthly' }).lean();
    assert.equal(inv.lines.length, 2);
    assert.equal(inv.buyer.gstin, '27AABCM1234F1Z5');
    assert.equal(inv.taxablePaise + inv.gstPaise, inv.totalPaise);
    const fleet = await Fleet.findOne({ name: 'Metro Cabs' }).lean();
    assert.equal(inv.totalPaise, fleet.outstandingPaise);
    const list = await api.get('/api/me/fleet/invoices').set(auth(mgr)).expect(200);
    assert.equal(list.body.invoices.length, 1);
    const pdf = await api.get(`/api/me/fleet/invoices/${inv._id}/pdf`).set(auth(mgr)).expect(200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal((await runMonthlyBilling(thisMonth())).fleetInvoices, 0, 'idempotent');
  });

  it('SaaS plan fee is invoiced once per month and deducted from the payout', async () => {
    const vg = await Tenant.findOne({ slug: 'voltgrid' });
    await Tenant.updateOne({ _id: vg._id }, { $set: { 'plan.monthlyFeePerChargerPaise': 50000, payoutDelayDays: 0 } });
    const r = await runMonthlyBilling(thisMonth());
    assert.equal(r.planFees, 1);
    assert.equal((await runMonthlyBilling(thisMonth())).planFees, 0, 'once per month');
    const adj = await Adjustment.findOne({ tenant: vg._id, ref: `saas:${vg._id}:${thisMonth()}` }).lean();
    assert.equal(adj.amountPaise, -(5 * 50000 * 1.18));
    assert.ok(await Invoice.exists({ kind: 'saas_fee', tenant: vg._id }));
    const p = await buildPayout(vg._id);
    assert.ok(p.adjustmentsPaise <= adj.amountPaise, 'fee deducted from payout');
  });
});

describe('operations', () => {
  it('alerts are delivered to the operator contacts once per incident', async () => {
    const vg = await Tenant.findOne({ slug: 'voltgrid' });
    const a = await raiseAlert({ tenant: vg._id, type: 'charger_fault', severity: 'critical', message: 'test fault', dedupeKey: 'test-deliver' });
    const delivered = await waitFor(async () => (await Alert.findById(a._id)).deliveredTo?.length && Alert.findById(a._id), { label: 'delivered' });
    assert.ok(delivered.deliveredTo.includes('ops@voltgrid.in'));
    await raiseAlert({ tenant: vg._id, type: 'charger_fault', severity: 'critical', message: 'again', dedupeKey: 'test-deliver' });
    assert.equal((await Alert.findById(a._id)).count, 2);
  });

  it('drivers can report a blocked spot without a session; ops are alerted', async () => {
    const r = await api.post('/api/public/chargers/VG-PUN-003/report').send({ category: 'spot_blocked', connector: 2, description: 'Car parked' }).expect(201);
    const c = await Complaint.findById(r.body.id).lean();
    assert.equal(c.category, 'spot_blocked');
    assert.ok(!c.session);
    assert.ok(await Alert.exists({ type: 'spot_blocked' }));
  });

  it('site host sees usage and revenue share of their own site', async () => {
    const vg = await Tenant.findOne({ slug: 'voltgrid' });
    const baner = await Site.findOne({ name: 'Baner Hub' });
    await Site.updateOne({ _id: baner._id }, { $set: { revenueShareBps: 1000 } });
    const host = new User({ email: 'landlord@baner.in', phone: '9600000099', name: 'Landlord', passwordHash: (await User.findOne({ email: 'owner@voltgrid.in' })).passwordHash, memberships: [{ tenant: vg._id, role: 'site_host', siteIds: [baner._id] }] });
    await host.save();
    const c = await sim('VG-PUN-002');
    await c.plugIn(1);
    const s = await guestSession({ ocppId: 'VG-PUN-002' });
    await waitFor(async () => (await sessionDoc(s.sessionId)).state === 'CHARGING', { label: 'charging' });
    await c.tick();
    await api.post(`/api/sessions/${s.sessionId}/stop`).set('x-session-token', s.accessToken);
    await waitFor(async () => (await sessionDoc(s.sessionId)).state === 'BILLED', { label: 'billed' });
    const t = await staffToken('landlord@baner.in');
    const r = await api.get('/api/cms/site-host/summary').set(auth(t)).expect(200);
    assert.equal(r.body.sites.length, 1);
    assert.equal(r.body.sites[0].name, 'Baner Hub');
    assert.ok(r.body.sites[0].sharePaise > 0);
    assert.equal((await api.get('/api/cms/finance/summary').set(auth(t))).status, 403);
  });

  it('sessions keep meter points for the graph, and API messages carry a translatable key', async () => {
    const s = await Session.findOne({ state: 'BILLED', 'meterPoints.1': { $exists: true } }).lean();
    assert.ok(s, 'meter points recorded');
    const doc = await Session.findOne({ state: 'BILLED', guestPhone: { $ne: null } });
    const view = await api.get(`/api/cms/sessions/${doc._id}/as-driver`).set(auth(await staffToken('owner@voltgrid.in'))).expect(200);
    assert.equal(view.body.messageKey, 'complete');
  });
});
