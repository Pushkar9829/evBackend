// UEI (Unified Energy Interface) — Beckn-protocol BPP endpoints for EV charging.
// Each request is ACKed synchronously; the result is sent to the BAP's on_<action> callback.
// Signing follows Beckn: ed25519 over "(created) (expires) digest" with a BLAKE-512 body digest.
import express from 'express';
import crypto from 'node:crypto';
import { Charger, RoamingPartner, Session, Site, Tenant, UeiOrder } from '../../models/index.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { randomId } from '../../lib/util.js';
import { getSettings, updateSettings } from '../../services/settings.js';
import { activeTariff, estimateForAmount } from '../../services/tariffs.js';
import { createSession, requestStop } from '../../services/sessionEngine.js';
import { events } from '../../services/events.js';
import { securityEvent } from '../../services/audit.js';

const router = express.Router();
export const UEI_SUBSCRIBER_ID = process.env.UEI_SUBSCRIBER_ID || 'bpp.chargex.in';
const DOMAIN = 'deg:ev-charging';

// ------------------------------------------------------------- signing

export async function platformKeys() {
  if (process.env.UEI_PRIVATE_KEY && process.env.UEI_PUBLIC_KEY) return { privateKey: process.env.UEI_PRIVATE_KEY, publicKey: process.env.UEI_PUBLIC_KEY };
  const s = await getSettings();
  if (s.ueiKeys?.privateKey) return s.ueiKeys;
  const kp = crypto.generateKeyPairSync('ed25519');
  const keys = {
    privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
  await updateSettings({ ueiKeys: keys });
  return keys;
}

const digest = (body) => crypto.createHash('blake2b512').update(body).digest('base64');
const signingString = (created, expires, body) => `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${digest(body)}`;

export function signBody(body, { subscriberId, uniqueKeyId = 'k1', privateKeyB64 }) {
  const created = Math.floor(Date.now() / 1000);
  const expires = created + 300;
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  const sig = crypto.sign(null, Buffer.from(signingString(created, expires, body)), key).toString('base64');
  return `Signature keyId="${subscriberId}|${uniqueKeyId}|ed25519",algorithm="ed25519",created="${created}",expires="${expires}",headers="(created) (expires) digest",signature="${sig}"`;
}

export function verifySignature(header, body, publicKeyB64) {
  const m = Object.fromEntries([...String(header).matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  if (!m.signature || !m.created || !m.expires) return { ok: false, reason: 'malformed' };
  const now = Math.floor(Date.now() / 1000);
  if (Number(m.expires) < now || Number(m.created) > now + 60) return { ok: false, reason: 'expired' };
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    const ok = crypto.verify(null, Buffer.from(signingString(m.created, m.expires, body)), key, Buffer.from(m.signature, 'base64'));
    return { ok, subscriberId: m.keyId?.split('|')[0] };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

router.use(express.raw({ type: '*/*', limit: '1mb' }));

/** Verify the BAP's signature against the registered partner key. */
router.use(async (req, res, next) => {
  const raw = req.body?.length ? req.body.toString('utf8') : '{}';
  req.rawText = raw;
  try {
    req.body = JSON.parse(raw);
  } catch {
    return res.status(400).json({ message: { ack: { status: 'NACK' } }, error: { code: '30000', message: 'Invalid JSON' } });
  }
  const keyId = /keyId="([^|"]+)/.exec(req.headers.authorization || '')?.[1];
  const partner = keyId ? await RoamingPartner.findOne({ protocol: 'uei', subscriberId: keyId }) : null;
  if (!partner || !partner.signingPublicKey) {
    await securityEvent('uei_unknown_subscriber', { keyId }, req.ip);
    return res.status(401).json({ message: { ack: { status: 'NACK' } }, error: { code: '10001', message: 'Unknown subscriber' } });
  }
  const v = verifySignature(req.headers.authorization, raw, partner.signingPublicKey);
  if (!v.ok) {
    await securityEvent('uei_bad_signature', { keyId, reason: v.reason }, req.ip);
    return res.status(401).json({ message: { ack: { status: 'NACK' } }, error: { code: '10001', message: 'Invalid signature' } });
  }
  if (!partner.enabled) return res.status(403).json({ message: { ack: { status: 'NACK' } }, error: { code: '40000', message: 'Partner disabled' } });
  req.partner = partner;
  return next();
});

const ack = (res) => res.json({ message: { ack: { status: 'ACK' } } });

/** Send on_<action> to the BAP, signed with our key. */
async function callback(req, action, message, error) {
  const ctx = req.body.context || {};
  const body = JSON.stringify({
    context: { ...ctx, action: `on_${action}`, bpp_id: UEI_SUBSCRIBER_ID, bpp_uri: `${config.publicApiUrl}/uei`, message_id: ctx.message_id, timestamp: new Date().toISOString() },
    message,
    ...(error ? { error } : {}),
  });
  const target = ctx.bap_uri || req.partner.subscriberUrl;
  if (!target) return;
  const keys = await platformKeys();
  await fetch(`${target.replace(/\/$/, '')}/on_${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: signBody(body, { subscriberId: UEI_SUBSCRIBER_ID, privateKeyB64: keys.privateKey }) },
    body,
    signal: AbortSignal.timeout(10000),
  }).catch((e) => logger.warn(`uei on_${action} to ${target}: ${e.message}`));
}

const later = (fn) => setImmediate(() => fn().catch((e) => logger.error('uei async', e)));

async function catalog(intent = {}) {
  const gps = intent.fulfillment?.stops?.[0]?.location?.gps || intent.location?.circle?.gps;
  const [lat, lng] = gps ? String(gps).split(',').map(Number) : [null, null];
  const radiusKm = Number(intent.location?.circle?.radius?.value || 25);
  const chargers = await Charger.find({ roamingEnabled: true, deletedAt: null, online: true, inService: true }).lean();
  const providers = new Map();
  for (const ch of chargers) {
    const site = await Site.findById(ch.site).lean();
    if (lat !== null && site?.location?.lat) {
      const d = Math.hypot((site.location.lat - lat) * 111, (site.location.lng - lng) * 111 * Math.cos((lat * Math.PI) / 180));
      if (d > radiusKm) continue;
    }
    const tenant = await Tenant.findById(ch.tenant).lean();
    if (tenant?.status !== 'active') continue;
    const tariff = await activeTariff(ch.tenant, ch.tariffKey);
    if (!providers.has(String(tenant._id))) providers.set(String(tenant._id), { id: String(tenant._id), descriptor: { name: tenant.name }, locations: [], items: [] });
    const p = providers.get(String(tenant._id));
    if (!p.locations.find((l) => l.id === String(site._id))) p.locations.push({ id: String(site._id), gps: `${site.location?.lat},${site.location?.lng}`, address: site.address, city: { name: site.city } });
    for (const c of ch.connectors) {
      p.items.push({
        id: `${ch.ocppId}:${c.number}`,
        descriptor: { name: `${c.type} ${c.maxPowerKw} kW`, code: c.powerType },
        price: { currency: 'INR', value: String((tariff?.energyPaisePerKwh || 0) / 100), unit: 'kWh' },
        location_ids: [String(site._id)],
        tags: [{ descriptor: { code: 'connector' }, list: [{ descriptor: { code: 'type' }, value: c.type }, { descriptor: { code: 'status' }, value: c.status }, { descriptor: { code: 'power_kw' }, value: String(c.maxPowerKw) }] }],
      });
    }
  }
  return { descriptor: { name: 'ChargeX network' }, providers: [...providers.values()] };
}

const parseItem = (id) => {
  const i = String(id).lastIndexOf(':');
  return { ocppId: id.slice(0, i), connectorNumber: Number(id.slice(i + 1)) };
};

async function quote(item, amountPaise) {
  const { ocppId, connectorNumber } = parseItem(item.id);
  const ch = await Charger.findOne({ ocppId, roamingEnabled: true }).lean();
  if (!ch) return null;
  const conn = ch.connectors.find((c) => c.number === connectorNumber);
  const tariff = await activeTariff(ch.tenant, conn?.tariffKey || ch.tariffKey);
  const amt = amountPaise || 20000;
  const est = estimateForAmount(tariff, amt, conn?.maxPowerKw);
  return { ch, conn, tariff, quote: { price: { currency: 'INR', value: (amt / 100).toFixed(2) }, breakup: [{ title: `Energy (est. ${est.kwh} kWh)`, price: { currency: 'INR', value: (amt / 100).toFixed(2) } }] } };
}

router.post('/search', (req, res) => {
  ack(res);
  later(async () => callback(req, 'search', { catalog: await catalog(req.body.message?.intent) }));
});

router.post('/select', (req, res) => {
  ack(res);
  later(async () => {
    const order = req.body.message?.order || {};
    const item = order.items?.[0];
    const amount = Math.round(Number(order.quote?.price?.value || item?.quantity?.selected?.measure?.value || 200) * 100);
    const q = item ? await quote(item, amount) : null;
    if (!q) return callback(req, 'select', {}, { code: '30004', message: 'Item not found' });
    return callback(req, 'select', { order: { provider: order.provider, items: [item], quote: q.quote } });
  });
});

router.post('/init', (req, res) => {
  ack(res);
  later(async () => {
    const ctx = req.body.context || {};
    const order = req.body.message?.order || {};
    const item = order.items?.[0];
    const amount = Math.round(Number(order.quote?.price?.value || 200) * 100);
    const q = item ? await quote(item, amount) : null;
    if (!q) return callback(req, 'init', {}, { code: '30004', message: 'Item not found' });
    const orderId = `UEI-${randomId(6)}`;
    await UeiOrder.create({ partner: req.partner._id, transactionId: ctx.transaction_id, orderId, charger: q.ch._id, connectorNumber: q.conn.number, stage: 'init', quotePaise: amount, context: ctx });
    // Payment is collected by the BAP; settled through roaming settlement.
    return callback(req, 'init', { order: { id: orderId, provider: order.provider, items: [item], quote: q.quote, payments: [{ collected_by: 'BAP', type: 'ON-ORDER', status: 'NOT-PAID' }] } });
  });
});

router.post('/confirm', (req, res) => {
  ack(res);
  later(async () => {
    const order = req.body.message?.order || {};
    const uo = await UeiOrder.findOne({ orderId: order.id, partner: req.partner._id });
    if (!uo) return callback(req, 'confirm', {}, { code: '30004', message: 'Order not found' });
    const ch = await Charger.findById(uo.charger).lean();
    try {
      const { session } = await createSession({ ocppId: ch.ocppId, connectorNumber: uo.connectorNumber, amountPaise: uo.quotePaise, uei: true, roaming: { partner: req.partner._id, protocol: 'uei', externalId: uo.orderId } });
      uo.session = session._id;
      uo.stage = 'confirmed';
      await uo.save();
      return callback(req, 'confirm', { order: { id: uo.orderId, status: 'ACTIVE', fulfillments: [{ state: { descriptor: { code: session.state } } }] } });
    } catch (e) {
      return callback(req, 'confirm', {}, { code: '30008', message: e.message });
    }
  });
});

async function orderStatus(uo) {
  const s = uo.session ? await Session.findById(uo.session).lean() : null;
  return {
    order: {
      id: uo.orderId,
      status: !s ? 'CREATED' : ['BILLED', 'COMPLETED'].includes(s.state) ? 'COMPLETED' : ['FAILED', 'CANCELLED'].includes(s.state) ? 'CANCELLED' : 'ACTIVE',
      fulfillments: [{ state: { descriptor: { code: s?.state || 'CREATED' } }, tags: [{ descriptor: { code: 'session' }, list: [{ descriptor: { code: 'energy_kwh' }, value: String((s?.energyWh || 0) / 1000) }, { descriptor: { code: 'amount_inr' }, value: String((s?.costs?.totalPaise || 0) / 100) }] }] }],
      quote: s?.costs?.totalPaise ? { price: { currency: 'INR', value: (s.costs.totalPaise / 100).toFixed(2) } } : undefined,
    },
  };
}

router.post('/status', (req, res) => {
  ack(res);
  later(async () => {
    const uo = await UeiOrder.findOne({ orderId: req.body.message?.order_id, partner: req.partner._id });
    if (!uo) return callback(req, 'status', {}, { code: '30004', message: 'Order not found' });
    return callback(req, 'status', await orderStatus(uo));
  });
});

router.post('/track', (req, res) => {
  ack(res);
  later(async () => callback(req, 'track', { tracking: { url: `${config.publicWebUrl}/uei/${req.body.message?.order_id}`, status: 'active' } }));
});

// update with fulfillment end => stop charging
router.post('/update', (req, res) => {
  ack(res);
  later(async () => {
    const order = req.body.message?.order || {};
    const uo = await UeiOrder.findOne({ orderId: order.id, partner: req.partner._id });
    if (!uo?.session) return callback(req, 'update', {}, { code: '30004', message: 'Order not found' });
    await requestStop(uo.session, { by: `uei:${req.partner.name}`, reason: 'roaming_stop' });
    return callback(req, 'update', await orderStatus(uo));
  });
});

router.post('/cancel', (req, res) => {
  ack(res);
  later(async () => {
    const uo = await UeiOrder.findOne({ orderId: req.body.message?.order_id, partner: req.partner._id });
    if (uo?.session) await requestStop(uo.session, { by: `uei:${req.partner.name}`, reason: 'roaming_cancel' });
    return callback(req, 'cancel', uo ? await orderStatus(uo) : {});
  });
});

/** Push unsolicited on_status when a UEI session is billed. */
export function attachUeiListeners() {
  events.on('session:billed', async (s) => {
    if (s.channel !== 'uei') return;
    const uo = await UeiOrder.findOne({ session: s._id });
    if (!uo) return;
    const partner = await RoamingPartner.findById(uo.partner);
    if (!partner) return;
    const fakeReq = { body: { context: { ...(uo.context || {}), message_id: randomId(8) } }, partner };
    await callback(fakeReq, 'status', await orderStatus(uo));
  });
}

export default router;
