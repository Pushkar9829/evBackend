// Phase 4 charger features: multi-node routing over Redis, Security Profile 3, Plug & Charge, OCPP 2.1 V2G.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, sim, guestSession, sessionDoc, waitFor, staffToken, driverToken, sleep, DEMO } from './helpers.js';
import { Charger, SecurityEvent, Session, Tariff, Tenant } from '../src/models/index.js';
import { createCluster, redisFactory } from '../src/ocpp/cluster.js';
import { rootCaPem } from '../src/services/pki.js';
import { VirtualCharger } from '../src/ocpp/simulator.js';

let api;
let ctx;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
before(async () => {
  ctx = await boot({ tls: true });
  api = ctx.api;
});
after(shutdown);

describe('cluster mode (Redis): commands reach the node holding the charger', () => {
  it('presence, command relay, session fan-out and a single job leader', async () => {
    const makeClient = await redisFactory('mock');
    const fakeConn = { closed: false, call: async (action, payload) => ({ status: 'Accepted', echo: { action, payload } }) };
    const seenOnB = [];
    const a = createCluster({ makeClient, nodeId: 'node-a', localConn: (id) => (id === 'CHG-1' ? fakeConn : undefined) });
    const b = createCluster({ makeClient, nodeId: 'node-b', localConn: () => undefined, onRemoteSession: (id) => seenOnB.push(id) });
    await a.start({ heldIds: () => ['CHG-1'] });
    await b.start({ heldIds: () => [] });
    try {
      await a.announce('CHG-1', true);
      await waitFor(() => b.remoteOwner('CHG-1') === 'node-a', { label: 'presence on B' });
      const r = await b.call('CHG-1', 'Reset', { type: 'OnIdle' }, 2000);
      assert.equal(r.status, 'Accepted');
      assert.equal(r.echo.action, 'Reset');
      await assert.rejects(() => b.call('NOPE', 'Reset', {}, 500), /not connected/);
      a.publishSession('abc123');
      await waitFor(() => seenOnB.includes('abc123'), { label: 'session fan-out' });
      assert.equal([a.isLeader(), b.isLeader()].filter(Boolean).length, 1, 'exactly one leader runs jobs');
      await a.announce('CHG-1', false);
      await waitFor(() => !b.remoteOwner('CHG-1'), { label: 'offline presence' });
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});

describe('OCPP Security Profile 3 (client certificates, mutual TLS)', () => {
  let c;
  let ops;
  it('install root CA, charger sends a CSR, we sign it, move to Profile 3 with approval, reconnect with the certificate', async () => {
    const ca = await rootCaPem();
    c = await sim('VG-MUM-001', { tlsUrl: `wss://localhost:${ctx.tlsPort}/ocpp`, ca });
    ops = await staffToken('ops@voltgrid.in');
    const owner = await staffToken('owner@voltgrid.in');
    const ch = await Charger.findOne({ ocppId: 'VG-MUM-001' });
    const cmd = (body) => api.post(`/api/cms/chargers/${ch._id}/commands`).set(auth(ops)).send(body);
    assert.equal((await cmd({ action: 'install_root' })).body.status, 'Accepted');
    assert.equal(c.certs.installed[0].certificateType, 'CSMSRootCertificate');
    const early = await cmd({ action: 'security_profile', profile: 3, reason: 'upgrade' });
    assert.equal(early.status, 400, 'no client certificate yet');
    assert.equal((await cmd({ action: 'renew_certificate' })).body.status, 'Accepted');
    await waitFor(async () => (await Charger.findById(ch._id)).certificate?.serial, { label: 'certificate issued', timeout: 15000 });
    assert.ok(c.certs.client.includes('BEGIN CERTIFICATE'));
    const req = await cmd({ action: 'security_profile', profile: 3, reason: 'upgrade to profile 3' });
    assert.equal(req.body.status, 'PendingApproval');
    const dec = await api.post(`/api/cms/approvals/${req.body.approvalId}/decide`).set(auth(owner)).send({ approve: true }).expect(200);
    assert.equal(dec.body.approval.status, 'executed');
    assert.equal((await Charger.findById(ch._id)).securityProfile, 3);
    // Reconnect over mutual TLS with the client certificate (no password)
    c.useTls = true;
    await c.disconnect({ keepWanting: true });
    await c.connect();
    await waitFor(async () => (await Charger.findById(ch._id)).online, { label: 'online over TLS' });
    assert.equal(c.online, true);
  });

  it('a Profile 3 charger cannot log in with just its password anymore', async () => {
    const intruder = new VirtualCharger({ url: `ws://127.0.0.1:${ctx.port}/ocpp`, ocppId: 'VG-MUM-001', password: DEMO.chargerPassword, protocol: 'ocpp2.0.1' });
    await assert.rejects(() => intruder.connect(), /401/);
    assert.ok(await SecurityEvent.exists({ type: 'ocpp_profile3_required' }));
  });

  it('a CSR for another charger id is refused (no impersonation)', async () => {
    const other = await sim('VG-PUN-001');
    other.ocppId = 'VG-MUM-001'; // CSR CN will not match the connection identity
    await other.requestCertificate();
    other.ocppId = 'VG-PUN-001';
    await sleep(800);
    const { Alert } = await import('../src/models/index.js');
    assert.ok(await Alert.exists({ message: /Certificate signing failed for VG-PUN-001/ }));
  });
});

describe('ISO 15118 Plug & Charge', () => {
  let emaid;
  let driver;
  let hashData;
  it('driver with UPI Autopay enables Plug & Charge: we issue an eMAID + contract certificate', async () => {
    driver = await driverToken('9444400001');
    await api.post('/api/me/autopay').set(auth(driver)).send({ maxPaise: 100000 }).expect(200);
    const v = await api.post('/api/me/vehicles').set(auth(driver)).send({ label: 'EV6', vehicleType: 'car', connectorTypes: ['CCS2'], batteryKwh: 77 }).expect(201);
    const r = await api.post(`/api/me/vehicles/${v.body.vehicles[0]._id}/pnc`).set(auth(driver)).expect(201);
    emaid = r.body.emaid;
    hashData = r.body.hashData;
    assert.match(emaid, /^IN-CHX-C[0-9A-F]{8}$/);
    assert.ok(r.body.certificateChain.includes('BEGIN CERTIFICATE'));
  });

  it('car plugs in, Authorize with certificate hash data is accepted, a postpaid "pnc" session starts and bills', async () => {
    const c = await sim('VG-PUN-001');
    const r = await c.plugInPnc(1, { emaid, hashData });
    assert.equal(r.status, 'Accepted');
    assert.equal(r.certificateStatus, 'Accepted');
    const s = await waitFor(() => Session.findOne({ channel: 'pnc', idToken: emaid, state: 'CHARGING' }).lean(), { label: 'pnc session' });
    assert.equal(s.postpaid, true);
    await c.tick();
    await c.unplug(1);
    const done = await waitFor(async () => { const d = await sessionDoc(s._id); return d.state === 'BILLED' && d; }, { label: 'billed' });
    assert.ok(done.costs.totalPaise > 0);
    assert.equal(done.refundPaise, 0);
  });

  it('wrong certificate hash is rejected (CertChainError); revoked contract stops working', async () => {
    const c = await sim('VG-PUN-001');
    const bad = await c.plugInPnc(1, { emaid, hashData: { ...hashData, serialNumber: '1234' } });
    assert.equal(bad.certificateStatus, 'CertChainError');
    await c.unplug(1);
    const me = await api.get('/api/me').set(auth(driver)).expect(200);
    await api.delete(`/api/me/vehicles/${me.body.user.vehicles[0]._id}/pnc`).set(auth(driver)).expect(200);
    const revoked = await c.plugInPnc(1, { emaid, hashData });
    assert.equal(revoked.certificateStatus, 'CertificateRevoked');
    assert.notEqual(revoked.status, 'Accepted');
  });
});

describe('OCPP 2.1 + V2G (bidirectional)', () => {
  it('2.1 charger connects; discharge needs approval; exported energy is credited on the bill', async () => {
    const gp = await Tenant.findOne({ slug: 'greenplug' });
    await Charger.updateOne({ ocppId: 'GP-BLR-001' }, { $set: { protocol: 'ocpp2.1', v2gCapable: true } });
    await Tariff.updateMany({ tenant: gp._id }, { $set: { v2gExportPaisePerKwh: 1000 } });
    const c = await sim('GP-BLR-001', { protocol: 'ocpp2.1' });
    assert.equal(c.ws.protocol, 'ocpp2.1', 'subprotocol negotiated');
    await c.plugIn(1);
    const s = await guestSession({ ocppId: 'GP-BLR-001', amountPaise: 50000 });
    await waitFor(async () => (await sessionDoc(s.sessionId)).state === 'CHARGING', { label: 'charging' });
    await c.tick();
    await c.tick();
    const gpOwner = await staffToken('owner@greenplug.in');
    const ch = await Charger.findOne({ ocppId: 'GP-BLR-001' });
    const req = await api.post(`/api/cms/chargers/${ch._id}/commands`).set(auth(gpOwner)).send({ action: 'v2g_discharge', connector: 1, kw: 11, minutes: 30, reason: 'evening peak support' });
    assert.equal(req.body.status, 'PendingApproval');
    const admin = await staffToken('admin@chargex.in');
    const dec = await api.post(`/api/cms/approvals/${req.body.approvalId}/decide`).set(auth(admin)).send({ approve: true }).expect(200);
    assert.equal(dec.body.approval.status, 'executed');
    assert.equal(c.conn(1).dischargeKw, 11);
    await c.tick();
    await sleep(200);
    const mid = await sessionDoc(s.sessionId);
    assert.ok(mid.exportedWh > 0, 'export register tracked');
    await api.post(`/api/sessions/${s.sessionId}/stop`).set('x-session-token', s.accessToken);
    const done = await waitFor(async () => { const d = await sessionDoc(s.sessionId); return d.state === 'BILLED' && d; }, { label: 'billed' });
    const bill = await api.get(`/api/cms/sessions/${s.sessionId}`).set(auth(gpOwner)).expect(200);
    const credit = bill.body.bill.lines.find((l) => l.code === 'v2g_credit');
    assert.ok(credit && credit.totalPaise < 0, 'credit line on the bill');
    assert.equal(done.costs.taxablePaise + done.costs.gstPaise, done.costs.totalPaise);
    assert.ok(done.costs.totalPaise >= 0, 'never below zero');
  });

  it('1.6J and 2.0.1 chargers refuse discharge', async () => {
    const ops = await staffToken('ops@voltgrid.in');
    const ch = await Charger.findOne({ ocppId: 'VG-PUN-002' });
    const r = await api.post(`/api/cms/chargers/${ch._id}/commands`).set(auth(ops)).send({ action: 'v2g_discharge', connector: 1, kw: 5, reason: 'x' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'NOT_V2G');
  });
});
