// Login & account (2.1) and security / multi-tenancy (2.11).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, shutdown, resetOtp, staffToken, driverToken, sim, guestSession, sessionDoc, waitFor } from './helpers.js';
import { AuditLog, OtpState, SecurityEvent, Session, Tenant, User, Charger } from '../src/models/index.js';

let api;
before(async () => {
  ({ api } = await boot());
});
after(shutdown);

describe('2.1 login and account', () => {
  it('ACC-01 valid OTP logs in and creates the profile on first login', async () => {
    await resetOtp();
    await api.post('/api/auth/otp/request').send({ phone: '9811111111' }).expect(200);
    const r = await api.post('/api/auth/otp/verify').send({ phone: '9811111111', code: '123456' }).expect(200);
    assert.ok(r.body.token);
    assert.equal(r.body.isNew, true);
    assert.ok(await User.exists({ phone: '9811111111' }));
  });

  it('ACC-02 wrong OTP gives a clear error each time; 5 wrong attempts lock for 15 min', async () => {
    await resetOtp();
    await api.post('/api/auth/otp/request').send({ phone: '9822222222' }).expect(200);
    for (let i = 1; i <= 4; i += 1) {
      const r = await api.post('/api/auth/otp/verify').send({ phone: '9822222222', code: '000000' });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'OTP_WRONG');
      assert.match(r.body.error.message, new RegExp(`${5 - i} attempts left`));
    }
    const locked = await api.post('/api/auth/otp/verify').send({ phone: '9822222222', code: '000000' });
    assert.equal(locked.status, 429);
    const st = await OtpState.findOne({ phone: '9822222222' });
    assert.ok(st.lockedUntil.getTime() - Date.now() > 14 * 60_000);
    const evenRight = await api.post('/api/auth/otp/verify').send({ phone: '9822222222', code: '123456' });
    assert.equal(evenRight.status, 429, 'still locked with the right code');
  });

  it('ACC-03 expired OTP says "OTP expired, resend?"', async () => {
    await resetOtp();
    await api.post('/api/auth/otp/request').send({ phone: '9833333333' }).expect(200);
    await OtpState.updateOne({ phone: '9833333333' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await api.post('/api/auth/otp/verify').send({ phone: '9833333333', code: '123456' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'OTP_EXPIRED');
  });

  it('ACC-04 / SEC-05 resend allowed after 30 s, max 5 per hour per number', async () => {
    await resetOtp();
    const phone = '9844444444';
    await api.post('/api/auth/otp/request').send({ phone }).expect(200);
    const tooSoon = await api.post('/api/auth/otp/request').send({ phone });
    assert.equal(tooSoon.status, 429);
    for (let i = 0; i < 4; i += 1) {
      await OtpState.updateOne({ phone }, { $set: { sentAt: new Date(Date.now() - 31_000) } });
      await api.post('/api/auth/otp/request').send({ phone }).expect(200);
    }
    await OtpState.updateOne({ phone }, { $set: { sentAt: new Date(Date.now() - 31_000) } });
    const sixth = await api.post('/api/auth/otp/request').send({ phone });
    assert.equal(sixth.status, 429);
    assert.match(sixth.body.error.message, /hour/);
  });

  it('ACC-07 phone change uses OTP on the new number and keeps history', async () => {
    const token = await driverToken('9855555555');
    const u = await User.findOne({ phone: '9855555555' });
    await Session.create({ tenant: (await Tenant.findOne())._id, charger: (await Charger.findOne())._id, driver: u._id, state: 'BILLED' });
    await api.post('/api/auth/phone-change/request').set('Authorization', `Bearer ${token}`).send({ phone: '9866666666' }).expect(200);
    await api.post('/api/auth/phone-change/verify').set('Authorization', `Bearer ${token}`).send({ phone: '9866666666', code: '123456' }).expect(200);
    const moved = await User.findById(u._id);
    assert.equal(moved.phone, '9866666666');
    assert.equal(await Session.countDocuments({ driver: u._id }), 1);
  });

  it('ACC-08 delete account anonymises the profile but keeps invoices', async () => {
    const token = await driverToken('9877777777');
    const r = await api.delete('/api/me').set('Authorization', `Bearer ${token}`);
    assert.equal(r.status, 200);
    const u = await User.findOne({ name: 'Deleted user', status: 'deleted' });
    assert.ok(u && !u.phone);
    const again = await api.get('/api/me').set('Authorization', `Bearer ${token}`);
    assert.equal(again.status, 401, 'old token revoked');
  });

  it('ACC-09 blocked user gets a polite message with support contact and cannot start', async () => {
    await User.updateOne({ phone: '9888888888' }, { $set: { phone: '9888888888', status: 'blocked' } }, { upsert: true });
    await resetOtp();
    await api.post('/api/auth/otp/request').send({ phone: '9888888888' });
    const r = await api.post('/api/auth/otp/verify').send({ phone: '9888888888', code: '123456' });
    assert.equal(r.status, 403);
    assert.match(r.body.error.message, /support/i);
  });

  it('staff with money roles must pass two-factor login', async () => {
    await resetOtp();
    const r = await api.post('/api/auth/staff/login').send({ email: 'owner@voltgrid.in', password: 'Demo@12345' }).expect(200);
    assert.equal(r.body.twoFactorRequired, true);
    assert.ok(!r.body.token);
    const bad = await api.post('/api/auth/staff/2fa').send({ challenge: r.body.challenge, code: '999999' });
    assert.equal(bad.status, 400);
  });
});

describe('2.11 security and multi-tenancy', () => {
  it('SEC-01 tenant A admin cannot read tenant B data by changing an id (403 + logged)', async () => {
    const vgOwner = await staffToken('owner@voltgrid.in');
    const gpCharger = await Charger.findOne({ ocppId: 'GP-BLR-001' });
    const r = await api.get(`/api/cms/chargers/${gpCharger._id}`).set('Authorization', `Bearer ${vgOwner}`);
    assert.equal(r.status, 403);
    assert.ok(await SecurityEvent.exists({ type: 'cross_tenant_access' }));
    const list = await api.get('/api/cms/chargers').set('Authorization', `Bearer ${vgOwner}`).expect(200);
    assert.ok(list.body.chargers.every((c) => c.tenant.name === 'VoltGrid Energy'));
  });

  it('SEC-02 charger with a wrong password is rejected; repeated failures alert ops', async () => {
    const { VirtualCharger } = await import('../src/ocpp/simulator.js');
    const { port } = await boot();
    for (let i = 0; i < 3; i += 1) {
      const v = new VirtualCharger({ url: `ws://127.0.0.1:${port}/ocpp`, ocppId: 'VG-MUM-001', password: 'wrong', protocol: 'ocpp2.0.1' });
      await assert.rejects(() => v.connect(), /401/);
    }
    const { Alert } = await import('../src/models/index.js');
    assert.ok(await Alert.exists({ dedupeKey: 'authfail:VG-MUM-001' }));
  });

  it('SEC-03 duplicate connection for the same id: newest wins, ops alerted', async () => {
    const a = await sim('VG-MUM-001');
    const b = await sim('VG-MUM-001');
    await waitFor(() => !a.online, { label: 'old socket closed' });
    assert.equal(b.online, true);
    const { Alert } = await import('../src/models/index.js');
    assert.ok(await Alert.exists({ dedupeKey: 'dup:VG-MUM-001' }));
  });

  it('SEC-04 a driver cannot stop another driver\'s session', async () => {
    await sim('VG-PUN-002');
    const s = await guestSession({ ocppId: 'VG-PUN-002', amountPaise: 10000 });
    const other = await driverToken('9899999999');
    const r = await api.post(`/api/sessions/${s.sessionId}/stop`).set('Authorization', `Bearer ${other}`);
    assert.equal(r.status, 403);
    const view = await api.post(`/api/sessions/${s.sessionId}/stop`).query({ v: s.viewToken });
    assert.equal(view.status, 403, 'read-only link cannot stop without OTP (QR-07)');
    await api.post(`/api/sessions/${s.sessionId}/cancel`).set('x-session-token', s.accessToken);
  });

  it('SEC-07 technician cannot see revenue in the API', async () => {
    const tech = await staffToken('tech@voltgrid.in');
    const r = await api.get('/api/cms/finance/summary').set('Authorization', `Bearer ${tech}`);
    assert.equal(r.status, 403);
    const ok = await api.get('/api/cms/chargers').set('Authorization', `Bearer ${tech}`);
    assert.equal(ok.status, 200);
  });

  it('SEC-09 phone numbers are masked in logs', async () => {
    const { mask } = await import('../src/lib/logger.js');
    assert.equal(mask('call 9876543210 now'), 'call 98******10 now');
  });

  it('audit log entries cannot be edited or deleted', async () => {
    const entry = await AuditLog.create({ action: 'test.entry' });
    await assert.rejects(() => AuditLog.updateOne({ _id: entry._id }, { $set: { action: 'x' } }));
    await assert.rejects(() => AuditLog.deleteOne({ _id: entry._id }));
  });

  it('admin console is platform-only', async () => {
    const owner = await staffToken('owner@voltgrid.in');
    const r = await api.get('/api/admin/tenants').set('Authorization', `Bearer ${owner}`);
    assert.equal(r.status, 403);
    const admin = await staffToken('admin@chargex.in');
    const r2 = await api.get('/api/admin/tenants').set('Authorization', `Bearer ${admin}`);
    assert.equal(r2.status, 200);
    assert.ok(r2.body.tenants.length >= 2);
  });
});
