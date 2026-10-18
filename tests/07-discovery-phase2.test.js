// Discovery (2.2) and Phase 2 features: Host mode, fleets, UPI Autopay, idle fee, time-of-day pricing.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, sim, sessionDoc, waitFor, driverToken, staffToken, guestSession } from './helpers.js';
import { Charger, Fleet, Session, Tenant, User } from '../src/models/index.js';
import { computeBill, energyRateAt } from '../src/services/tariffs.js';

let api;
before(async () => {
  ({ api } = await boot());
});
after(shutdown);

describe('2.2 discovery and charger status', () => {
  it('DIS-02/04 offline or faulted chargers are hidden by default, greyed out when filters are off', async () => {
    const c = await sim('VG-MUM-001');
    const on = await api.get('/api/public/chargers').expect(200);
    assert.ok(on.body.chargers.some((x) => x.ocppId === 'VG-MUM-001'));
    assert.ok(!on.body.chargers.some((x) => x.ocppId === 'VG-PUN-002'), 'offline hidden');
    const all = await api.get('/api/public/chargers?available=false').expect(200);
    const off = all.body.chargers.find((x) => x.ocppId === 'VG-PUN-002');
    assert.ok(off && off.working === false && off.connectors.every((x) => x.status === 'Offline'));
    await c.disconnect();
  });

  it('DIS-05 filter by connector type and 2W/3W', async () => {
    await sim('VG-MUM-001');
    await sim('VG-PUN-001');
    const r = await api.get('/api/public/chargers?vehicle=2W').expect(200);
    assert.ok(r.body.chargers.length >= 1 && r.body.chargers.every((x) => x.connectors.some((c) => c.vehicleTypes.includes('2W'))));
    const ccs = await api.get('/api/public/chargers?connector=CCS2').expect(200);
    assert.ok(ccs.body.chargers.every((x) => x.connectors.some((c) => c.type === 'CCS2')));
  });

  it('DIS-06 no chargers nearby: nearest one returned with a widen-search hint', async () => {
    const r = await api.get('/api/public/chargers?lat=28.61&lng=77.2&radiusKm=10').expect(200);
    assert.equal(r.body.nearestOnly, true);
    assert.equal(r.body.chargers.length, 1);
    assert.ok(r.body.chargers[0].distanceKm > 100);
  });

  it('DIS-07 price shown = price billed (same tariff version)', async () => {
    const shown = (await api.get('/api/public/chargers/VG-MUM-001')).body.price;
    const v = await sim('VG-MUM-001');
    await v.plugIn(1);
    const s = await guestSession({ ocppId: 'VG-MUM-001', connector: 1 });
    await waitFor(async () => (await sessionDoc(s.sessionId)).state === 'CHARGING', { label: 'charging' });
    const d = await sessionDoc(s.sessionId);
    assert.equal(d.tariff.version, shown.tariffVersion);
    assert.equal(d.tariff.lockedEnergyPaisePerKwh, shown.energyPaisePerKwh, 'rate shown = rate locked for the session');
    await api.post(`/api/sessions/${s.sessionId}/stop`).set('x-session-token', s.accessToken);
  });
});

describe('Phase 2', () => {
  it('Host mode: self-serve signup creates a one-person tenant, charger credentials and price', async () => {
    const token = await driverToken('9700000001');
    const r = await api.post('/api/me/host').set('Authorization', `Bearer ${token}`).send({ displayName: 'Sharma General Store', address: 'MG Road, Pune', city: 'Pune', lat: 18.52, lng: 73.85 }).expect(201);
    assert.ok(r.body.setup.password && r.body.setup.chargerId.startsWith('HOST-'));
    const t = await Tenant.findById(r.body.tenant.id);
    assert.equal(t.type, 'host');
    const cms = await api.post('/api/auth/host-session').set('Authorization', `Bearer ${token}`).expect(200);
    const list = await api.get('/api/cms/chargers').set('Authorization', `Bearer ${cms.body.token}`).expect(200);
    assert.equal(list.body.chargers.length, 1);
    await api.patch('/api/me/host/price').set('Authorization', `Bearer ${token}`).send({ pricePaisePerKwh: 2000 }).expect(200);
    const h = await api.get('/api/me/host').set('Authorization', `Bearer ${token}`).expect(200);
    assert.equal(h.body.pricePaisePerKwh, 2000);
    // host chargers need 30 days > 90% uptime before roaming
    const rr = await api.post(`/api/cms/chargers/${list.body.chargers[0]._id}/roaming`).set('Authorization', `Bearer ${cms.body.token}`).send({ enabled: true });
    assert.equal(rr.status, 403, 'roaming flag off for new hosts');
  });

  it('Fleet: manager adds a driver with a spend limit; fleet sessions are postpaid on the fleet', async () => {
    const mgr = await driverToken('9700000010');
    await api.post('/api/me/fleet').set('Authorization', `Bearer ${mgr}`).send({ name: 'QuickCabs', creditLimitPaise: 500000 }).expect(201);
    await api.post('/api/me/fleet/drivers').set('Authorization', `Bearer ${mgr}`).send({ phone: '9700000011', spendLimitPaise: 30000 }).expect(201);
    const drv = await driverToken('9700000011');
    const c = await sim('VG-PUN-001');
    await c.plugIn(2);
    const r = await api.post('/api/sessions').set('Authorization', `Bearer ${drv}`).send({ ocppId: 'VG-PUN-001', connector: 2, fleet: true }).expect(201);
    await waitFor(async () => (await sessionDoc(r.body.sessionId)).state === 'CHARGING', { label: 'fleet charging' });
    const doc = await sessionDoc(r.body.sessionId);
    assert.equal(doc.channel, 'fleet');
    assert.equal(doc.capPaise, 30000);
    await c.tick();
    await api.post(`/api/sessions/${r.body.sessionId}/stop`).set('Authorization', `Bearer ${drv}`);
    await waitFor(async () => (await sessionDoc(r.body.sessionId)).state === 'BILLED', { label: 'billed' });
    const fleet = await Fleet.findOne({ name: 'QuickCabs' });
    assert.equal(fleet.outstandingPaise, (await sessionDoc(r.body.sessionId)).costs.totalPaise);
  });

  it('UPI Autopay: app user charges without prepay and the mandate is charged after the session', async () => {
    const t = await driverToken('9700000020');
    await api.post('/api/me/autopay').set('Authorization', `Bearer ${t}`).send({ maxPaise: 100000 }).expect(200);
    const c = await sim('VG-PUN-001');
    await c.plugIn(2);
    const r = await api.post('/api/sessions').set('Authorization', `Bearer ${t}`).send({ ocppId: 'VG-PUN-001', connector: 2 }).expect(201);
    await waitFor(async () => (await sessionDoc(r.body.sessionId)).state === 'CHARGING', { label: 'charging' });
    await c.tick();
    await api.post(`/api/sessions/${r.body.sessionId}/stop`).set('Authorization', `Bearer ${t}`);
    const d = await waitFor(async () => {
      const x = await sessionDoc(r.body.sessionId);
      return x.state === 'BILLED' && x.payment && x;
    }, { label: 'charged' });
    assert.equal(d.postpaid, true);
    assert.equal(d.refundPaise, 0);
  });

  it('Idle fee starts exactly after the grace period and is capped', () => {
    const tariff = { energyPaisePerKwh: 1800, idle: { paisePerMin: 200, graceMin: 15, capPaise: 2000 }, gstRateBps: 1800 };
    const t0 = new Date('2026-10-18T10:00:00Z');
    const base = { tariff, energyWh: 1000, costs: { energyExact: 1800 }, startedAt: t0, chargingEndedAt: new Date(t0.getTime() + 30 * 60_000) };
    const inGrace = computeBill({ ...base, endedAt: new Date(base.chargingEndedAt.getTime() + 15 * 60_000) });
    assert.equal(inGrace.idlePaise, 0);
    const after5 = computeBill({ ...base, endedAt: new Date(base.chargingEndedAt.getTime() + 20 * 60_000) });
    assert.equal(after5.lines.find((l) => l.code === 'idle').amount, 1000);
    const capped = computeBill({ ...base, endedAt: new Date(base.chargingEndedAt.getTime() + 120 * 60_000) });
    assert.equal(capped.lines.find((l) => l.code === 'idle').amount, 2000);
  });

  it('Time-of-day: current price + next change shown; the rate at start is locked for the whole session', async () => {
    const { currentPrice, snapshot, energyRateAt: rateAt } = await import('../src/services/tariffs.js');
    const t = { energyPaisePerKwh: 2200, tod: [{ startHour: 18, endHour: 22, energyPaisePerKwh: 2500, label: 'Evening peak' }] };
    const p = currentPrice(t, new Date('2026-10-18T11:00:00Z')); // 16:30 IST
    assert.equal(p.energyPaisePerKwh, 2200);
    assert.equal(p.next.energyPaisePerKwh, 2500);
    assert.equal(new Date(p.next.at).toISOString(), '2026-10-18T12:30:00.000Z'); // 18:00 IST
    const snap = snapshot(t, {}, { at: new Date('2026-10-18T11:00:00Z') });
    assert.equal(rateAt(snap, new Date('2026-10-18T13:30:00Z')), 2200, 'peak band later in the session does not change the locked price');
  });

  it('Time-of-day pricing uses IST bands', () => {
    const t = { energyPaisePerKwh: 2200, tod: [{ startHour: 18, endHour: 22, energyPaisePerKwh: 2500 }, { startHour: 0, endHour: 6, energyPaisePerKwh: 1900 }] };
    assert.equal(energyRateAt(t, new Date('2026-10-18T13:30:00Z')), 2500); // 19:00 IST
    assert.equal(energyRateAt(t, new Date('2026-10-18T20:00:00Z')), 1900); // 01:30 IST
    assert.equal(energyRateAt(t, new Date('2026-10-18T06:30:00Z')), 2200); // 12:00 IST
  });

  it('promo code: discount applied on the bill, use + budget recorded, one use per driver', async () => {
    const { PromoCode } = await import('../src/models/index.js');
    await PromoCode.create({ code: 'FIRST20', kind: 'percent', value: 2000, perUserLimit: 1, budgetPaise: 100000 });
    const c = await sim('VG-PUN-001');
    await c.plugIn(2);
    const r = await api.post('/api/sessions').send({ ocppId: 'VG-PUN-001', connector: 2, amountPaise: 20000, phone: '9700000099', promoCode: 'first20' }).expect(201);
    await api.post(`/api/payments/mock/${r.body.orderId}/complete`).send({ outcome: 'success' });
    await waitFor(async () => (await sessionDoc(r.body.sessionId)).state === 'CHARGING', { label: 'charging' });
    await c.tick();
    await api.post(`/api/sessions/${r.body.sessionId}/stop`).set('x-session-token', r.body.accessToken);
    const d = await waitFor(async () => { const x = await sessionDoc(r.body.sessionId); return x.state === 'BILLED' && x; }, { label: 'billed' });
    assert.ok(d.costs.discountPaise > 0);
    assert.equal(d.costs.taxablePaise + d.costs.gstPaise, d.costs.totalPaise);
    const p = await waitFor(async () => { const x = await PromoCode.findOne({ code: 'FIRST20' }); return x.usedPaise > 0 && x; }, { label: 'promo use recorded' });
    assert.equal(p.usedPaise, d.costs.discountPaise);
    const again = await api.post('/api/sessions').send({ ocppId: 'VG-PUN-001', connector: 2, amountPaise: 20000, phone: '9700000099', promoCode: 'FIRST20' });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'PROMO_USED');
  });

  it('white-label branding is served per tenant', async () => {
    const owner = await staffToken('owner@voltgrid.in');
    await api.patch('/api/cms/company').set('Authorization', `Bearer ${owner}`).send({ branding: { appName: 'VoltGo', primaryColor: '#0a7d4f' } }).expect(200);
    const b = await api.get('/api/public/branding/voltgrid').expect(200);
    assert.equal(b.body.name, 'VoltGo');
  });

  it('driver history is grouped by month and "charge again" remembers the last charger', async () => {
    const t = await driverToken('9700000020');
    const h = await api.get('/api/me/sessions').set('Authorization', `Bearer ${t}`).expect(200);
    assert.ok(h.body.months[0].sessions.length >= 1);
    const home = await api.get('/api/me/home').set('Authorization', `Bearer ${t}`).expect(200);
    assert.equal(home.body.chargeAgain.charger.ocppId, 'VG-PUN-001');
    assert.ok(await User.exists({ phone: '9700000020', lastChargerId: { $ne: null } }));
    assert.ok(await Session.exists({}));
    assert.ok(await Charger.exists({}));
  });
});
