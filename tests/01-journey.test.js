// Core charging journey on simulated 2.0.1 and 1.6J chargers (Phase 1 milestone 1).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, sim, guestSession, getSession, sessionDoc, waitFor, sleep } from './helpers.js';

let api;
before(async () => {
  ({ api } = await boot());
});
after(shutdown);

async function fullJourney(ocppId, connector = 1) {
  const charger = await sim(ocppId);
  await charger.plugIn(connector);
  const s = await guestSession({ ocppId, connector, amountPaise: 20000 });
  // STA-01: Charging only after the charger confirms
  await waitFor(async () => (await sessionDoc(s.sessionId)).state === 'CHARGING', { label: 'CHARGING' });
  for (let i = 0; i < 3; i += 1) await charger.tick(); // each tick = 1 simulated minute
  await sleep(200);
  const live = await getSession(s.sessionId, s.accessToken);
  assert.equal(live.state, 'CHARGING');
  assert.ok(live.energyWh > 0, 'energy recorded');
  assert.ok(live.liveCostPaise > 0, 'live cost shown');
  const stop = await api.post(`/api/sessions/${s.sessionId}/stop`).set('x-session-token', s.accessToken);
  assert.equal(stop.status, 200);
  await waitFor(async () => (await sessionDoc(s.sessionId)).invoice, { label: 'BILLED + invoice' });
  const done = await sessionDoc(s.sessionId);
  assert.ok(done.costs.totalPaise > 0 && done.costs.totalPaise <= 20000);
  assert.equal(done.costs.taxablePaise + done.costs.gstPaise, done.costs.totalPaise, 'taxable + GST = total (BIL-04)');
  assert.equal(done.refundPaise, 20000 - done.costs.totalPaise, 'refund = prepaid - bill (BIL-03)');
  const view = await getSession(s.sessionId, s.accessToken);
  assert.ok(view.invoice?.number, 'invoice issued');
  assert.equal(view.refunds[0].status, 'succeeded');
  await charger.disconnect();
  return done;
}

describe('charging journey', () => {
  it('guest QR -> UPI -> charge -> stop -> bill on OCPP 2.0.1', async () => {
    const d = await fullJourney('VG-PUN-001', 1);
    assert.equal(d.channel, 'qr');
  });

  it('same journey on a 1.6J charger through the adapter (STA-10)', async () => {
    const d = await fullJourney('VG-PUN-002', 1);
    assert.ok(d.transactionId, '1.6 transaction id assigned');
  });

  it('QR landing shows connector, price and amount estimates (QR-01)', async () => {
    await sim('VG-PUN-003');
    const r = await api.get('/api/public/qr/VG-PUN-003/2');
    assert.equal(r.status, 200);
    assert.equal(r.body.connector.number, 2);
    assert.equal(r.body.amounts.length, 3);
    assert.ok(r.body.price.energyPaisePerKwh > 0);
  });

  it('disabled charger QR returns alternatives (QR-03)', async () => {
    const { Charger } = await import('../src/models/index.js');
    await Charger.updateOne({ ocppId: 'VG-MUM-002' }, { $set: { inService: false } });
    const r = await api.get('/api/public/qr/VG-MUM-002/1');
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'NOT_IN_SERVICE');
    assert.ok(Array.isArray(r.body.alternatives));
  });
});
