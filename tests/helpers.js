import './env.js';
import request from 'supertest';
import mongoose from 'mongoose';
import { startServer } from '../src/server.js';
import { seed, DEMO } from '../scripts/seed.js';
import { VirtualCharger } from '../src/ocpp/simulator.js';
import { stopJobs } from '../src/services/jobs.js';
import { stopAllSims } from '../src/services/simulators.js';
import { invalidateSettings } from '../src/services/settings.js';
import { OtpState } from '../src/models/index.js';

export { DEMO };
let ctx = null;

/** One server + freshly seeded test DB per test file. */
export async function boot({ tls = false } = {}) {
  if (ctx) return ctx;
  const { server, port, tlsServer, tlsPort } = await startServer({ port: 0, jobs: false, tlsPort: tls ? 0 : undefined });
  await seed({ reset: true, quiet: true });
  invalidateSettings();
  const api = request(server);
  ctx = { server, port, api, sims: [], tlsServer, tlsPort };
  return ctx;
}

export async function shutdown() {
  if (!ctx) return;
  for (const s of ctx.sims) await s.disconnect().catch(() => {});
  await stopAllSims();
  stopJobs();
  await sleep(800); // let in-flight handlers finish
  if (ctx.tlsServer) {
    ctx.tlsServer.closeAllConnections?.();
    await new Promise((r) => ctx.tlsServer.close(r));
  }
  await new Promise((r) => ctx.server.close(r));
  ctx.server.closeAllConnections?.();
  await mongoose.disconnect();
  ctx = null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 8000, every = 100, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Clears OTP rate-limit state so tests can log in repeatedly. */
export const resetOtp = () => OtpState.deleteMany({});

export async function staffToken(email, password = DEMO.password) {
  await resetOtp();
  const { api } = ctx;
  const r = await api.post('/api/auth/staff/login').send({ email, password });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  if (!r.body.twoFactorRequired) return r.body.token;
  const r2 = await api.post('/api/auth/staff/2fa').send({ challenge: r.body.challenge, code: '123456' });
  if (r2.status !== 200) throw new Error(`2fa ${email}: ${JSON.stringify(r2.body)}`);
  return r2.body.token;
}

export async function driverToken(phone = DEMO.driverPhone) {
  await resetOtp();
  const { api } = ctx;
  await api.post('/api/auth/otp/request').send({ phone });
  const r = await api.post('/api/auth/otp/verify').send({ phone, code: '123456' });
  if (r.status !== 200) throw new Error(`driver login: ${JSON.stringify(r.body)}`);
  return r.body.token;
}

/** Connect a virtual charger (seeded password) and wait until the server sees it online. */
export async function sim(ocppId, { protocol, connectors, meterIntervalSec = 600, speed = 0.1, ...rest } = {}) {
  const { Charger } = await import('../src/models/index.js');
  const ch = await Charger.findOne({ ocppId }).lean();
  const v = new VirtualCharger({
    url: `ws://127.0.0.1:${ctx.port}/ocpp`,
    ocppId,
    password: DEMO.chargerPassword,
    protocol: protocol || ch.protocol,
    connectors: connectors || ch.connectors.map((c) => ({ number: c.number, maxPowerKw: c.maxPowerKw })),
    meterIntervalSec,
    speed,
    connectionTimeoutSec: 2,
    ...rest,
  });
  await v.connect();
  ctx.sims.push(v);
  await waitFor(async () => (await Charger.findOne({ ocppId }).lean()).online, { label: `${ocppId} online` });
  await sleep(300); // initial StatusNotifications
  return v;
}

/** Create a guest QR session and pay it through the mock gateway. */
export async function guestSession({ ocppId, connector = 1, amountPaise = 20000, phone = '9123456789', pay = 'success', extra = {} } = {}) {
  const { api } = ctx;
  const r = await api.post('/api/sessions').send({ ocppId, connector, amountPaise, phone, idempotencyKey: `k-${Date.now()}-${Math.random()}` });
  if (r.status !== 201) throw new Error(`create session: ${r.status} ${JSON.stringify(r.body)}`);
  if (pay) await api.post(`/api/payments/mock/${r.body.orderId}/complete`).send({ outcome: pay, ...extra });
  return r.body;
}

export async function getSession(id, token) {
  const r = await ctx.api.get(`/api/sessions/${id}`).set('x-session-token', token);
  return r.body;
}

export async function sessionDoc(id) {
  const { Session } = await import('../src/models/index.js');
  return Session.findById(id).lean();
}
