// Starting (2.5), during charging (2.6) and stopping (2.7), run on the simulator with fault injection.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, sim, guestSession, getSession, sessionDoc, waitFor, sleep } from './helpers.js';
import { Alert, Charger, CommandLog, Refund, Session, Tariff } from '../src/models/index.js';
import { tickSessions } from '../src/services/sessionEngine.js';

let api;
before(async () => {
  ({ api } = await boot());
});
after(shutdown);

const state = async (id) => (await sessionDoc(id)).state;
const until = (id, st, label = st) => waitFor(async () => (await state(id)) === st, { label });
const fullRefund = async (id, amount = 20000) => {
  const r = await waitFor(() => Refund.findOne({ session: id, status: 'succeeded' }).lean(), { label: 'refund' });
  assert.equal(r.amountPaise, amount);
};
const stop = (s) => api.post(`/api/sessions/${s.sessionId}/stop`).set('x-session-token', s.accessToken);

describe('2.5 starting a session', () => {
  let c;
  before(async () => {
    c = await sim('VG-PUN-001'); // 2.0.1, connector 1 = DC 60 kW, 2 = AC 22 kW
  });

  it('STA-02 paid but not plugged in: "Plug in" for the window, then cancel + full refund', async () => {
    const s = await guestSession({ ocppId: 'VG-PUN-001', connector: 2 });
    await until(s.sessionId, 'STARTING');
    const v = await getSession(s.sessionId, s.accessToken);
    assert.match(v.message, /Plug the cable/);
    await sleep(2200); // test plug-in window = 2 s
    await tickSessions();
    assert.equal(await state(s.sessionId), 'FAILED');
    assert.equal((await sessionDoc(s.sessionId)).failureReason, 'not_plugged_in');
    await fullRefund(s.sessionId);
  });

  it('STA-03 charger rejects the start: failed, instant full refund, suggest another connector', async () => {
    c.faults.rejectStart = true;
    await c.plugIn(2);
    const s = await guestSession({ ocppId: 'VG-PUN-001', connector: 2 });
    await until(s.sessionId, 'FAILED');
    const v = await getSession(s.sessionId, s.accessToken);
    assert.match(v.message, /didn't accept/);
    await fullRefund(s.sessionId);
    c.faults.rejectStart = false;
  });

  it('STA-04 accepted but never Started: query the charger, then fail + refund', async () => {
    c.faults.neverStart = true;
    const s = await guestSession({ ocppId: 'VG-PUN-001', connector: 2 });
    await until(s.sessionId, 'STARTING');
    await sleep(2200);
    await tickSessions();
    assert.equal(await state(s.sessionId), 'FAILED');
    assert.ok(await CommandLog.exists({ ocppId: 'VG-PUN-001', action: 'GetTransactionStatus' }));
    await fullRefund(s.sessionId);
    c.faults.neverStart = false;
  });

  it('STA-05 late Started after a refund: stop sent, "late start", not billed, ops alerted', async () => {
    c.faults.neverStart = true;
    const s = await guestSession({ ocppId: 'VG-PUN-001', connector: 2 });
    await until(s.sessionId, 'STARTING');
    await sleep(2200);
    await tickSessions();
    await until(s.sessionId, 'FAILED');
    const doc = await sessionDoc(s.sessionId);
    c.faults.neverStart = false;
    await c.startTx(c.conn(2), { idToken: doc.idToken, remoteStartId: doc.remoteStartId });
    await waitFor(async () => (await sessionDoc(s.sessionId)).flags.includes('late_start'), { label: 'late_start flag' });
    await waitFor(() => !c.conn(2).tx, { label: 'charger stopped' });
    const after2 = await sessionDoc(s.sessionId);
    assert.equal(after2.state, 'FAILED');
    assert.equal(after2.costs.totalPaise, 0);
    assert.ok(await Alert.exists({ type: 'late_start', session: s.sessionId }));
    assert.equal(await Refund.countDocuments({ session: s.sessionId }), 1, 'driver never pays twice');
  });

  it('STA-07 faulted connector is blocked before payment', async () => {
    await c.setFault(2, true);
    await sleep(200);
    const r = await api.post('/api/sessions').send({ ocppId: 'VG-PUN-001', connector: 2, amountPaise: 20000, phone: '9123400001' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'CONNECTOR_UNAVAILABLE');
    await c.setFault(2, false);
  });

  it('STA-08 car not accepting charge: no energy for the limit -> stop + full refund', async () => {
    c.conn(2).evSuspended = true;
    const s = await guestSession({ ocppId: 'VG-PUN-001', connector: 2 });
    await until(s.sessionId, 'CHARGING');
    await c.tick();
    await sleep(2200);
    await tickSessions();
    await until(s.sessionId, 'BILLED');
    assert.equal((await sessionDoc(s.sessionId)).costs.totalPaise, 0, 'no energy = no money (BIL-01)');
    await fullRefund(s.sessionId);
    c.conn(2).evSuspended = false;
  });

  it('STA-06 charger goes offline between payment and start: failed + refund', async () => {
    const s = await guestSession({ ocppId: 'VG-PUN-001', connector: 1, pay: false });
    await c.disconnect();
    await waitFor(async () => !(await Charger.findOne({ ocppId: 'VG-PUN-001' })).online, { label: 'offline' });
    await api.post(`/api/payments/mock/${s.orderId}/complete`).send({ outcome: 'success' });
    await until(s.sessionId, 'FAILED');
    await fullRefund(s.sessionId);
    c = await sim('VG-PUN-001');
  });

  it('STA-11 charger asking Authorize for the session token gets Accepted', async () => {
    await c.plugIn(1);
    c.faults.neverStart = true;
    const s = await guestSession({ ocppId: 'VG-PUN-001', connector: 1 });
    await until(s.sessionId, 'STARTING');
    const doc = await sessionDoc(s.sessionId);
    const r = await c.call('Authorize', { idToken: { idToken: doc.idToken, type: 'Central' } });
    assert.equal(r.idTokenInfo.status, 'Accepted');
    c.faults.neverStart = false;
    await api.post(`/api/sessions/${s.sessionId}/cancel`).set('x-session-token', s.accessToken);
    await until(s.sessionId, 'FAILED');
  });
});

describe('2.6 during charging', () => {
  let c;
  before(async () => {
    c = await sim('VG-MUM-002'); // 1.6J DC 30 kW
    await c.plugIn(1);
  });

  async function charging(amountPaise = 20000) {
    const s = await guestSession({ ocppId: 'VG-MUM-002', amountPaise });
    await until(s.sessionId, 'CHARGING');
    return s;
  }

  it('CHG-01 live kWh and Rs match tariff x energy; CHG-03 backwards / jump readings rejected', async () => {
    const s = await charging();
    await c.tick();
    await sleep(150);
    const before1 = await sessionDoc(s.sessionId);
    c.faults.wrongMeterNext = 'backwards';
    await c.sendMeter(c.conn(1));
    c.faults.wrongMeterNext = 'jump';
    await c.sendMeter(c.conn(1));
    await sleep(200);
    const d = await sessionDoc(s.sessionId);
    assert.equal(d.energyWh, before1.energyWh, 'billing uses the last valid reading');
    assert.ok(d.flags.includes('meter_rejected') && d.reviewNeeded);
    const v = await getSession(s.sessionId, s.accessToken);
    const exp = Math.round((d.energyWh * d.tariff.energyPaisePerKwh) / 1000);
    assert.ok(Math.abs(v.liveCostPaise - Math.round(exp * 1.18)) <= 2, `live cost ${v.liveCostPaise} ~ ${exp} + GST`);
    await stop(s);
    await until(s.sessionId, 'BILLED');
  });

  it('CHG-04 meter register reset after reboot: energy computed per segment, never negative or doubled', async () => {
    const s = await charging();
    await c.tick();
    await sleep(100);
    const e1 = (await sessionDoc(s.sessionId)).energyWh;
    await c.resetMeterRegister(1);
    await c.tick();
    await sleep(150);
    const d = await sessionDoc(s.sessionId);
    assert.ok(d.flags.includes('meter_reset'));
    assert.ok(d.energyWh > e1 && d.energyWh < e1 * 3, `segment energy ${e1} -> ${d.energyWh}`);
    await stop(s);
    await until(s.sessionId, 'BILLED');
  });

  it('CHG-05 charger offline mid-session, reconnects: queued messages accepted, no duplicate energy', async () => {
    const s = await charging();
    await c.tick();
    await c.disconnect();
    await until(s.sessionId, 'INTERRUPTED');
    const v = await getSession(s.sessionId, s.accessToken);
    assert.match(v.message, /charging continues/);
    await c.tick(); // queued while offline
    await c.tick();
    const expectedWh = c.conn(1).meterWh;
    await c.connect();
    await waitFor(async () => (await sessionDoc(s.sessionId)).state === 'CHARGING', { label: 'resumed' });
    await sleep(300);
    const d = await sessionDoc(s.sessionId);
    assert.equal(d.meter.lastWh, expectedWh);
    await stop(s);
    await until(s.sessionId, 'BILLED');
  });

  it('CHG-07 duplicate and CHG-08 out-of-order TransactionEvents are processed once, in order (2.0.1)', async () => {
    const c2 = await sim('GP-BLR-001');
    await c2.plugIn(1);
    const s = await guestSession({ ocppId: 'GP-BLR-001', amountPaise: 50000 });
    await until(s.sessionId, 'CHARGING');
    c2.faults.duplicateNext = true;
    await c2.tick();
    await sleep(200);
    const afterDup = await sessionDoc(s.sessionId);
    c2.faults.reorderNext = true;
    await c2.tick();
    await c2.tick();
    await sleep(300);
    const d = await sessionDoc(s.sessionId);
    assert.equal(d.meter.lastWh, c2.conn(1).meterWh, 'newest reading wins');
    assert.ok(!d.flags.includes('meter_rejected'), 'older reading is ignored, not flagged');
    assert.ok(afterDup.energyWh > 0);
    await stop(s);
    await until(s.sessionId, 'BILLED');
    await c2.disconnect();
  });

  it('CHG-09/10 prepaid amount reached: auto stop, bill never above the prepaid amount', async () => {
    const s = await charging(5000); // Rs 50 at Rs 22/kWh + GST ~ 1.9 kWh; each tick ~0.5 kWh at 30 kW x 1 min
    for (let i = 0; i < 6 && (await state(s.sessionId)) === 'CHARGING'; i += 1) {
      await c.tick();
      await sleep(150);
    }
    await until(s.sessionId, 'BILLED');
    const d = await sessionDoc(s.sessionId);
    assert.equal(d.stopReason, 'limit');
    assert.ok(d.costs.totalPaise <= 5000);
    assert.equal(d.costs.taxablePaise + d.costs.gstPaise, d.costs.totalPaise);
    const v = await getSession(s.sessionId, s.accessToken);
    assert.match(v.message, /has been used/);
  });

  it('CHG-11 tariff changed mid-session: the running session keeps its version', async () => {
    const s = await charging();
    const t = await Tariff.findOne({ key: 'dc-fast' }).sort({ version: -1 });
    await Tariff.create({ ...t.toObject(), _id: undefined, version: t.version + 1, energyPaisePerKwh: 9900, createdAt: undefined, updatedAt: undefined });
    await c.tick();
    await stop(s);
    await until(s.sessionId, 'BILLED');
    const d = await sessionDoc(s.sessionId);
    assert.equal(d.tariff.version, t.version);
    assert.notEqual(d.tariff.energyPaisePerKwh, 9900);
    await Tariff.deleteOne({ key: 'dc-fast', version: t.version + 1 });
  });
});

describe('2.7 stopping', () => {
  let c;
  before(async () => {
    c = await sim('VG-PUN-002'); // 1.6J AC
    await c.plugIn(1);
  });
  const charging = async () => {
    const s = await guestSession({ ocppId: 'VG-PUN-002' });
    await until(s.sessionId, 'CHARGING');
    await c.tick();
    return s;
  };

  it('STP-02 charger rejects remote stop: retried once, driver told to unplug, ops alerted', async () => {
    const s = await charging();
    c.faults.rejectStop = true;
    const r = await stop(s);
    assert.equal(r.body.rejected, true);
    assert.match(r.body.message, /unplug/);
    assert.equal(await CommandLog.countDocuments({ ocppId: 'VG-PUN-002', action: 'RequestStopTransaction', status: 'Rejected' }), 2);
    assert.ok(await Alert.exists({ type: 'stop_rejected', session: s.sessionId }));
    c.faults.rejectStop = false;
    await c.unplug(1); // STP-03 driver unplugs
    await until(s.sessionId, 'BILLED');
    assert.equal((await sessionDoc(s.sessionId)).stopReason, 'EVDisconnected');
    await c.plugIn(1);
  });

  it('STP-04 stop pressed twice: single stop, second shows "Already stopping"', async () => {
    const s = await charging();
    c.faults.slowStopMs = 800;
    const [a, b] = await Promise.all([stop(s), stop(s)]);
    assert.ok([a.body, b.body].some((x) => x.alreadyStopping));
    c.faults.slowStopMs = 0;
    await until(s.sessionId, 'BILLED');
  });

  it('STP-05 stop pressed while the charger is offline: queued, driver told to unplug, settles on reconnect', async () => {
    const s = await charging();
    await c.disconnect();
    await until(s.sessionId, 'INTERRUPTED');
    const r = await stop(s);
    assert.equal(r.body.queued, true);
    await c.connect();
    await waitFor(async () => (await state(s.sessionId)) === 'BILLED', { label: 'billed after reconnect', timeout: 20000 });
  });

  it('STP-06 Ended never received but connector Available: closed on last reading, flagged', async () => {
    const s = await charging();
    c.conn(1).tx = null; // charger "forgets" the transaction
    c.conn(1).plugged = false;
    await c.sendStatus(c.conn(1));
    await sleep(200);
    await Session.updateOne({ _id: s.sessionId }, { $set: { availableSince: new Date(Date.now() - 61_000) } });
    await tickSessions();
    await until(s.sessionId, 'BILLED');
    const d = await sessionDoc(s.sessionId);
    assert.ok(d.flags.includes('ended_missing') && d.reviewNeeded);
    assert.ok(d.costs.totalPaise > 0);
  });

  it('STP-07 cable stuck: driver can unlock; failure shows the support contact', async () => {
    await c.plugIn(1);
    const s = await charging();
    await stop(s);
    await until(s.sessionId, 'BILLED');
    c.faults.unlockFails = true;
    const r = await api.post(`/api/sessions/${s.sessionId}/unlock`).set('x-session-token', s.accessToken).expect(200);
    assert.equal(r.body.ok, false);
    assert.match(r.body.message, /support/);
    c.faults.unlockFails = false;
  });
});
