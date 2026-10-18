// Phase 3 access features: custom roles, tenant API keys, data-rights workflow, route planner, providers.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { boot, shutdown, sim, guestSession, sessionDoc, waitFor, staffToken, driverToken, resetOtp } from './helpers.js';
import { AuditLog, DataRequest, Invoice, Session, Tenant, User } from '../src/models/index.js';
import { config } from '../src/config.js';
import { sendPush, sendSms } from '../src/services/providers.js';
import { invoicePdfBuffer } from '../src/services/invoices.js';

let api;
let owner;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
before(async () => {
  ({ api } = await boot());
  owner = await staffToken('owner@voltgrid.in');
});
after(shutdown);

describe('custom roles (tenant-defined)', () => {
  let roleValue;
  it('owner builds a role from the permission list; escalation beyond own permissions is refused', async () => {
    const cat = await api.get('/api/cms/roles').set(auth(owner)).expect(200);
    assert.ok(cat.body.permissions.includes('session.view'));
    assert.ok(!cat.body.permissions.includes('platform.switches'), 'platform permissions are never assignable');
    const r = await api.post('/api/cms/roles').set(auth(owner)).send({ name: 'Night shift', perms: ['session.view', 'charger.view', 'alert.view', 'session.refund'], refundLimitPaise: 10000 }).expect(201);
    roleValue = r.body.value;
    const ops = await staffToken('ops@voltgrid.in');
    const esc = await api.post('/api/cms/roles').set(auth(ops)).send({ name: 'Sneaky', perms: ['finance.view'] });
    assert.equal(esc.status, 403, 'ops (no staff.manage) cannot create roles');
    const bad = await api.post('/api/cms/roles').set(auth(owner)).send({ name: 'Bad', perms: ['platform.switches'] });
    assert.equal(bad.status, 400);
  });

  it('a staff member with the custom role gets exactly those permissions, re-checked on every request', async () => {
    await api.post('/api/cms/staff').set(auth(owner)).send({ email: 'night@voltgrid.in', name: 'Night Shift', phone: '9555500001', role: roleValue, password: 'Night@12345' }).expect(201);
    const t = await staffToken('night@voltgrid.in', 'Night@12345'); // has session.refund -> money role -> 2FA path
    const me = await api.get('/api/auth/me').set(auth(t)).expect(200);
    assert.equal(me.body.permissions.length, 4);
    assert.equal(me.body.contexts[0].roleName, 'Night shift');
    await api.get('/api/cms/sessions').set(auth(t)).expect(200);
    assert.equal((await api.get('/api/cms/finance/summary').set(auth(t))).status, 403);
    const id = roleValue.slice(7);
    await api.patch(`/api/cms/roles/${id}`).set(auth(owner)).send({ perms: ['charger.view'] }).expect(200);
    assert.equal((await api.get('/api/cms/sessions').set(auth(t))).status, 403, 'permission removal applies immediately');
    const del = await api.delete(`/api/cms/roles/${id}`).set(auth(owner));
    assert.equal(del.status, 409, 'cannot archive a role still assigned');
    assert.ok(await AuditLog.exists({ action: 'role.update' }));
  });
});

describe('tenant API keys + /api/v1', () => {
  let key;
  let c;
  it('issue a scoped key (shown once, stored hashed)', async () => {
    const r = await api.post('/api/cms/api-keys').set(auth(owner)).send({ name: 'ERP sync', scopes: ['chargers:read', 'sessions:read', 'sessions:write'] }).expect(201);
    key = r.body.key;
    assert.match(key, /^cx_[A-Za-z0-9]{8}_/);
    const list = await api.get('/api/cms/api-keys').set(auth(owner)).expect(200);
    assert.ok(!JSON.stringify(list.body).includes(key.split('_')[2]), 'secret never returned again');
  });

  it('reads chargers and sessions of its own tenant only; scopes enforced', async () => {
    const ch = await api.get('/api/v1/chargers').set('Authorization', `Bearer ${key}`).expect(200);
    assert.ok(ch.body.data.every((x) => x.ocppId.startsWith('VG-')));
    assert.equal((await api.get('/api/v1/tariffs').set('Authorization', `Bearer ${key}`)).status, 403, 'missing tariffs:read');
    assert.equal((await api.get('/api/v1/chargers').set('Authorization', 'Bearer cx_AAAAAAAA_notarealkeyatallnope')).status, 401);
    const gp = await Tenant.findOne({ slug: 'greenplug' });
    const gpSession = await Session.create({ tenant: gp._id, charger: (await (await import('../src/models/index.js')).Charger.findOne({ ocppId: 'GP-BLR-001' }))._id, state: 'BILLED' });
    assert.equal((await api.get(`/api/v1/sessions/${gpSession._id}`).set('X-Api-Key', key)).status, 403, 'tenant isolation');
  });

  it('remote start/stop from the tenant system, audit-logged as the key', async () => {
    c = await sim('VG-PUN-002');
    await c.plugIn(1);
    const s = await api.post('/api/v1/chargers/VG-PUN-002/connectors/1/start').set('Authorization', `Bearer ${key}`).send({ reason: 'fleet depot test' }).expect(201);
    await waitFor(async () => (await sessionDoc(s.body.data.id)).state === 'CHARGING', { label: 'charging' });
    await c.tick();
    await api.post(`/api/v1/sessions/${s.body.data.id}/stop`).set('Authorization', `Bearer ${key}`).send({ reason: 'done' }).expect(200);
    await waitFor(async () => (await sessionDoc(s.body.data.id)).state === 'BILLED', { label: 'billed' });
    const log = await AuditLog.findOne({ action: 'api.remote_start' }).lean();
    assert.equal(log.actorName, 'api:ERP sync');
    const page = await api.get('/api/v1/sessions?limit=1').set('Authorization', `Bearer ${key}`).expect(200);
    assert.equal(page.body.data.length, 1);
    assert.ok(page.body.next);
  });

  it('revoked keys stop working', async () => {
    const list = await api.get('/api/cms/api-keys').set(auth(owner)).expect(200);
    await api.post(`/api/cms/api-keys/${list.body.keys[0]._id}/revoke`).set(auth(owner)).send({}).expect(200);
    const r = await api.get('/api/v1/me').set('Authorization', `Bearer ${key}`);
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'API_KEY_REVOKED');
  });
});

describe('data rights workflow (DPDP)', () => {
  it('driver downloads all their data', async () => {
    const t = await driverToken('9876543210');
    const r = await api.get('/api/me/data-export').set(auth(t)).expect(200);
    assert.equal(r.body.profile.phone, '9876543210');
    assert.ok(Array.isArray(r.body.sessions));
    assert.ok(await DataRequest.exists({ kind: 'export', source: 'self_service' }));
  });

  it('guest proves the phone with OTP, requests deletion; platform team executes it; invoices kept without identity', async () => {
    const c = await sim('VG-PUN-002');
    await c.plugIn(1);
    const s = await guestSession({ ocppId: 'VG-PUN-002', phone: '9333300001' });
    await waitFor(async () => (await sessionDoc(s.sessionId)).state === 'CHARGING', { label: 'charging' });
    await c.tick();
    await api.post(`/api/sessions/${s.sessionId}/stop`).set('x-session-token', s.accessToken);
    await waitFor(async () => (await sessionDoc(s.sessionId)).invoice, { label: 'invoice' });
    await resetOtp();
    await api.post('/api/public/data-requests/otp').send({ phone: '9333300001' }).expect(200);
    const req = await api.post('/api/public/data-requests').send({ phone: '9333300001', code: '123456', kind: 'delete' }).expect(201);
    const admin = await staffToken('admin@chargex.in');
    const list = await api.get('/api/admin/data-requests?status=received').set(auth(admin)).expect(200);
    assert.ok(list.body.requests.some((r) => String(r._id) === String(req.body.request.id)));
    await api.post(`/api/admin/data-requests/${req.body.request.id}/execute`).set(auth(admin)).send({ note: 'verified by OTP' }).expect(200);
    const doc = await sessionDoc(s.sessionId);
    assert.equal(doc.guestPhone, undefined);
    const inv = await Invoice.findById(doc.invoice).lean();
    assert.equal(inv.status, 'issued', 'invoice kept for the tax period');
    assert.equal(inv.buyer.phone, null);
    assert.equal((await DataRequest.findById(req.body.request.id)).status, 'completed');
  });
});

describe('route planner', () => {
  it('suggests a charging stop on the corridor when the range is short', async () => {
    await sim('VG-PUN-001');
    const r = await api.post('/api/public/route-plan').send({ from: { lat: 18.5913, lng: 73.7389 }, to: { lat: 18.5679, lng: 73.9143 }, rangeKm: 40, socPct: 40, reservePct: 15 }).expect(200);
    assert.ok(r.body.totalKm > 15);
    assert.equal(r.body.feasible, true);
    assert.equal(r.body.stops.length, 1);
    assert.match(r.body.stops[0].site.name, /Baner|Phoenix/);
    assert.ok(r.body.navigationUrl.includes('waypoints='));
  });

  it('reports when no working charger is in range', async () => {
    const r = await api.post('/api/public/route-plan').send({ from: { lat: 18.52, lng: 73.85 }, to: { lat: 21.15, lng: 79.09 }, rangeKm: 60, socPct: 60 }).expect(200);
    assert.equal(r.body.feasible, false);
    assert.match(r.body.message, /No working charger/);
  });

  it('no stop needed when the battery is enough', async () => {
    const r = await api.post('/api/public/route-plan').send({ from: { lat: 18.5913, lng: 73.7389 }, to: { lat: 18.5679, lng: 73.9143 }, rangeKm: 300, socPct: 90 }).expect(200);
    assert.equal(r.body.stops.length, 0);
    assert.ok(r.body.arriveSocPct > 70);
  });
});

describe('real providers (stubbed network)', () => {
  it('MSG91 SMS goes through the DLT flow template', async () => {
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      return new Response(JSON.stringify({ type: 'success' }), { status: 200 });
    };
    const prev = config.sms.provider;
    config.sms.provider = 'msg91';
    process.env.MSG91_AUTH_KEY = 'test-key';
    try {
      await sendSms('9876543210', { body: 'x', templateId: 'flow123', vars: { code: '111111' } });
      assert.equal(calls[0].url, 'https://control.msg91.com/api/v5/flow/');
      assert.equal(calls[0].body.template_id, 'flow123');
      assert.equal(calls[0].body.recipients[0].mobiles, '919876543210');
      assert.equal(calls[0].headers.authkey, 'test-key');
      await assert.rejects(() => sendSms('9876543210', { body: 'x' }), /DLT/);
    } finally {
      globalThis.fetch = realFetch;
      config.sms.provider = prev;
      delete process.env.MSG91_AUTH_KEY;
    }
  });

  it('FCM push: signs a service-account JWT, sends, and reports dead tokens for SMS fallback', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.FCM_SERVICE_ACCOUNT = JSON.stringify({ project_id: 'chargex-test', client_email: 'push@chargex-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('oauth2')) {
        const assertion = new URLSearchParams(init.body).get('assertion');
        assert.equal(assertion.split('.').length, 3);
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      const token = JSON.parse(init.body).message.token;
      if (token === 'dead') return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
      return new Response(JSON.stringify({ name: 'projects/x/messages/1' }), { status: 200 });
    };
    try {
      const r = await sendPush([{ token: 'good' }, { token: 'dead' }], { body: 'Charging started' });
      assert.equal(r.sent, 1);
      assert.deepEqual(r.invalidTokens, ['dead']);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.FCM_SERVICE_ACCOUNT;
    }
  });

  it('invoice PDFs render to a buffer for email attachments', async () => {
    const inv = await Invoice.findOne({ status: 'issued' });
    const buf = await invoicePdfBuffer(inv);
    assert.equal(buf.slice(0, 5).toString(), '%PDF-');
    assert.ok(await User.exists({}));
  });
});
