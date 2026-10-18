// Roaming (2.12): OCPI 2.2.1 as CPO with a fake eMSP partner, and UEI (Beckn) with signed requests.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { boot, shutdown, sim, sessionDoc, waitFor, staffToken, sleep } from './helpers.js';
import { Cdr, Charger, RoamingPartner, Session, Settlement } from '../src/models/index.js';
import { pushPendingCdrs } from '../src/roaming/ocpi/client.js';
import { signBody } from '../src/roaming/uei/routes.js';

let api;
let admin;
let partnerSrv;
let partnerUrl;
const received = { commandResults: [], sessions: [], cdrs: [], beckn: [] };
let cdrFail = false;

const enc = (t) => `Token ${Buffer.from(t).toString('base64')}`;

before(async () => {
  ({ api } = await boot());
  admin = await staffToken('admin@chargex.in');
  // Fake partner: OCPI eMSP + Beckn BAP
  const app = express();
  app.use(express.json());
  app.get('/ocpi/versions', (_q, r) => r.json({ status_code: 1000, data: [{ version: '2.2.1', url: `${partnerUrl}/ocpi/2.2.1` }] }));
  app.get('/ocpi/2.2.1', (_q, r) => r.json({ status_code: 1000, data: { version: '2.2.1', endpoints: [
    { identifier: 'sessions', role: 'RECEIVER', url: `${partnerUrl}/ocpi/sessions` },
    { identifier: 'cdrs', role: 'RECEIVER', url: `${partnerUrl}/ocpi/cdrs` },
  ] } }));
  app.post('/ocpi/results/:id', (q, r) => { received.commandResults.push(q.body); r.json({ status_code: 1000 }); });
  app.put('/ocpi/sessions/:cc/:pid/:id', (q, r) => { received.sessions.push(q.body); r.json({ status_code: 1000 }); });
  app.post('/ocpi/cdrs', (q, r) => {
    if (cdrFail) return r.status(503).json({ status_code: 3000 });
    received.cdrs.push(q.body);
    return r.json({ status_code: 1000 });
  });
  app.post('/bap/:action', (q, r) => { received.beckn.push({ action: q.params.action, body: q.body }); r.json({ message: { ack: { status: 'ACK' } } }); });
  partnerSrv = http.createServer(app);
  await new Promise((r) => partnerSrv.listen(0, r));
  partnerUrl = `http://127.0.0.1:${partnerSrv.address().port}`;
});
after(async () => {
  partnerSrv?.close();
  await shutdown();
});

describe('OCPI 2.2.1 (CPO)', () => {
  let tokenC;
  let charger;

  it('credentials handshake: token A registers once, we issue token C', async () => {
    const p = await RoamingPartner.findOne({ name: 'Demo eMSP (OCPI)' });
    const tokenA = p.tokenA;
    const v = await api.get('/ocpi/versions').set('Authorization', enc(tokenA)).expect(200);
    assert.equal(v.body.data[0].version, '2.2.1');
    const denied = await api.get('/ocpi/2.2.1/locations').set('Authorization', enc(tokenA));
    assert.equal(denied.status, 401, 'token A only allows credentials');
    const r = await api.post('/ocpi/2.2.1/credentials').set('Authorization', enc(tokenA)).send({ token: 'partner-token-b', url: `${partnerUrl}/ocpi/versions`, roles: [{ role: 'EMSP', country_code: 'IN', party_id: 'DEM' }] }).expect(200);
    tokenC = r.body.data.token;
    assert.ok(tokenC);
    assert.ok(r.body.data.roles.some((x) => x.role === 'CPO' && x.party_id === 'VGE'));
    const reg = await RoamingPartner.findById(p._id);
    assert.equal(reg.status, 'registered');
    assert.equal(reg.endpoints.get('cdrs'), `${partnerUrl}/ocpi/cdrs`);
    const reuse = await api.get('/ocpi/versions').set('Authorization', enc(tokenA));
    assert.equal(reuse.status, 401, 'token A is single-use');
  });

  it('locations feed shows only roaming-enabled chargers with OCPI statuses', async () => {
    charger = await sim('VG-PUN-001');
    await charger.plugIn(1);
    const r = await api.get('/ocpi/2.2.1/locations').set('Authorization', enc(tokenC)).expect(200);
    const evses = r.body.data.flatMap((l) => l.evses.map((e) => e.uid));
    assert.ok(evses.includes('VG-PUN-001*1'));
    assert.ok(!evses.some((u) => u.startsWith('GP-')), 'GreenPlug has roaming off');
    assert.ok(r.headers['x-total-count']);
  });

  it('ROM-02 unknown or blocked token: START_SESSION rejected with the OCPI response', async () => {
    const site = (await Charger.findOne({ ocppId: 'VG-PUN-001' })).site;
    const r = await api.post('/ocpi/2.2.1/commands/START_SESSION').set('Authorization', enc(tokenC)).send({ response_url: `${partnerUrl}/ocpi/results/x`, token: { uid: 'UNKNOWN1' }, location_id: String(site), evse_uid: 'VG-PUN-001*1' }).expect(200);
    assert.equal(r.body.data.result, 'REJECTED');
  });

  it('ROM-01 START_SESSION for our charger: token validated, OCPP start, OCPI session + result, CDR on stop', async () => {
    const site = (await Charger.findOne({ ocppId: 'VG-PUN-001' })).site;
    await api.put('/ocpi/2.2.1/tokens/IN/DEM/DRV001').set('Authorization', enc(tokenC)).send({ uid: 'DRV001', type: 'APP_USER', contract_id: 'IN-DEM-DRV001', valid: true, whitelist: 'ALLOWED' }).expect(200);
    const r = await api.post('/ocpi/2.2.1/commands/START_SESSION').set('Authorization', enc(tokenC)).send({ response_url: `${partnerUrl}/ocpi/results/1`, token: { uid: 'DRV001' }, location_id: String(site), evse_uid: 'VG-PUN-001*1', connector_id: '1', authorization_reference: 'AUTH-1' }).expect(200);
    assert.equal(r.body.data.result, 'ACCEPTED');
    const s = await waitFor(() => Session.findOne({ channel: 'roaming', state: 'CHARGING' }).lean(), { label: 'roaming session charging' });
    await waitFor(() => received.commandResults.find((x) => x.result === 'ACCEPTED'), { label: 'command result' });
    await charger.tick();
    const stop = await api.post('/ocpi/2.2.1/commands/STOP_SESSION').set('Authorization', enc(tokenC)).send({ response_url: `${partnerUrl}/ocpi/results/2`, session_id: String(s._id) }).expect(200);
    assert.equal(stop.body.data.result, 'ACCEPTED');
    await waitFor(async () => (await sessionDoc(s._id)).state === 'BILLED', { label: 'billed' });
    const cdr = await waitFor(() => received.cdrs.find((c) => c.session_id === String(s._id)), { label: 'cdr pushed' });
    assert.ok(cdr.total_energy > 0);
    assert.equal(cdr.authorization_reference, 'AUTH-1');
    assert.ok(received.sessions.some((x) => x.id === String(s._id)));
  });

  it('ROM-03 CDR push fails while the partner is down: retried with backoff, visible until delivered', async () => {
    cdrFail = true;
    const site = (await Charger.findOne({ ocppId: 'VG-PUN-001' })).site;
    await api.post('/ocpi/2.2.1/commands/START_SESSION').set('Authorization', enc(tokenC)).send({ response_url: `${partnerUrl}/ocpi/results/3`, token: { uid: 'DRV001' }, location_id: String(site), evse_uid: 'VG-PUN-001*1', connector_id: '1' }).expect(200);
    const s = await waitFor(() => Session.findOne({ channel: 'roaming', state: 'CHARGING' }).lean(), { label: 'charging' });
    await charger.tick();
    await api.post('/ocpi/2.2.1/commands/STOP_SESSION').set('Authorization', enc(tokenC)).send({ response_url: `${partnerUrl}/ocpi/results/4`, session_id: String(s._id) });
    const failed = await waitFor(async () => {
      const c = await Cdr.findOne({ session: s._id });
      return c?.status === 'failed' && c;
    }, { label: 'cdr failed' });
    assert.ok(failed.nextAttemptAt > new Date());
    const listed = await api.get('/api/admin/roaming/cdrs').query({ status: 'failed' }).set('Authorization', `Bearer ${admin}`);
    assert.ok(listed.body.cdrs.some((c) => String(c._id) === String(failed._id)));
    cdrFail = false;
    await Cdr.updateOne({ _id: failed._id }, { $set: { nextAttemptAt: new Date() } });
    await pushPendingCdrs();
    assert.equal((await Cdr.findById(failed._id)).status, 'sent');
  });

  it('ROM-04 month-end totals differ: dispute with the session list', async () => {
    const p = await RoamingPartner.findOne({ name: 'Demo eMSP (OCPI)' });
    const month = new Date().toISOString().slice(0, 7);
    const r = await api.post('/api/admin/roaming/settlements').set('Authorization', `Bearer ${admin}`).send({ partner: String(p._id), month, theirTotalPaise: 1 }).expect(200);
    assert.equal(r.body.settlement.status, 'disputed');
    assert.ok(r.body.sessions.length >= 1);
    assert.ok(await Settlement.exists({ partner: p._id, month }));
  });

  it('ROM-05 roaming disabled for a charger: removed from the Locations feed', async () => {
    const owner = await staffToken('owner@voltgrid.in');
    const ch = await Charger.findOne({ ocppId: 'VG-PUN-001' });
    await api.post(`/api/cms/chargers/${ch._id}/roaming`).set('Authorization', `Bearer ${owner}`).send({ enabled: false, reason: 'test' }).expect(200);
    const r = await api.get('/ocpi/2.2.1/locations').set('Authorization', enc(tokenC)).expect(200);
    assert.ok(!r.body.data.flatMap((l) => l.evses.map((e) => e.uid)).includes('VG-PUN-001*1'));
    await api.post(`/api/cms/chargers/${ch._id}/roaming`).set('Authorization', `Bearer ${owner}`).send({ enabled: true, reason: 'test' }).expect(200);
  });

  it('partner switched off: their calls are refused instantly', async () => {
    const p = await RoamingPartner.findOne({ name: 'Demo eMSP (OCPI)' });
    await api.patch(`/api/admin/roaming/partners/${p._id}`).set('Authorization', `Bearer ${admin}`).send({ enabled: false, reason: 'partner incident' }).expect(200);
    const r = await api.get('/ocpi/2.2.1/locations').set('Authorization', enc(tokenC));
    assert.equal(r.status, 403);
    await api.patch(`/api/admin/roaming/partners/${p._id}`).set('Authorization', `Bearer ${admin}`).send({ enabled: true, reason: 'resolved' }).expect(200);
  });
});

describe('UEI (Beckn) BPP', () => {
  let bapKeys;
  before(async () => {
    const kp = crypto.generateKeyPairSync('ed25519');
    bapKeys = { privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), publicKey: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
    await api.post('/api/admin/roaming/partners').set('Authorization', `Bearer ${admin}`).send({ name: 'Test BAP', protocol: 'uei', subscriberId: 'bap.test', subscriberUrl: `${partnerUrl}/bap`, signingPublicKey: bapKeys.publicKey }).expect(201);
  });

  const beckn = (action, message, { sign = true } = {}) => {
    const body = JSON.stringify({ context: { domain: 'deg:ev-charging', action, bap_id: 'bap.test', bap_uri: `${partnerUrl}/bap`, transaction_id: 'txn-1', message_id: `m-${Math.random()}`, timestamp: new Date().toISOString() }, message });
    const req = api.post(`/uei/${action}`).set('Content-Type', 'application/json');
    if (sign) req.set('Authorization', signBody(body, { subscriberId: 'bap.test', privateKeyB64: bapKeys.privateKey }));
    else req.set('Authorization', 'Signature keyId="bap.test|k1|ed25519",created="1",expires="2",signature="AAAA"');
    return req.send(body);
  };

  it('rejects an invalid signature', async () => {
    const r = await beckn('search', { intent: {} }, { sign: false });
    assert.equal(r.status, 401);
  });

  it('search -> on_search catalog; select/init/confirm -> charging; status -> on_status', async () => {
    const r = await beckn('search', { intent: { location: { circle: { gps: '18.559,73.7868', radius: { value: '30' } } } } });
    assert.equal(r.body.message.ack.status, 'ACK');
    const onSearch = await waitFor(() => received.beckn.find((x) => x.action === 'on_search'), { label: 'on_search' });
    const items = onSearch.body.message.catalog.providers.flatMap((p) => p.items);
    const item = items.find((i) => i.id === 'VG-PUN-001:1');
    assert.ok(item, 'our charger in the catalog');
    await beckn('init', { order: { items: [{ id: item.id }], quote: { price: { value: '150' } } } });
    const onInit = await waitFor(() => received.beckn.find((x) => x.action === 'on_init'), { label: 'on_init' });
    const orderId = onInit.body.message.order.id;
    await beckn('confirm', { order: { id: orderId } });
    await waitFor(() => received.beckn.find((x) => x.action === 'on_confirm'), { label: 'on_confirm' });
    const s = await waitFor(() => Session.findOne({ channel: 'uei', state: 'CHARGING' }).lean(), { label: 'uei charging' });
    assert.equal(s.capPaise, 15000);
    await beckn('update', { order: { id: orderId } });
    await waitFor(async () => (await sessionDoc(s._id)).state === 'BILLED', { label: 'billed' });
    await beckn('status', { order_id: orderId });
    const st = await waitFor(() => received.beckn.find((x) => x.action === 'on_status' && x.body.message.order.status === 'COMPLETED'), { label: 'on_status completed' });
    assert.ok(st);
    await sleep(100);
  });
});
