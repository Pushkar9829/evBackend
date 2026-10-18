// OCPI 2.2.1 endpoints. We are CPO for every tenant (party per tenant) and eMSP for our own app.
import express from 'express';
import { Charger, Cdr, RoamingCommand, RoamingPartner, RoamingToken, Session, Site, Tariff, Tenant } from '../../models/index.js';
import { config } from '../../config.js';
import { randomToken } from '../../lib/util.js';
import { logger } from '../../lib/logger.js';
import { activeTariff } from '../../services/tariffs.js';
import { createSession, requestStop } from '../../services/sessionEngine.js';
import { sendCommand } from '../../ocpp/commands.js';
import { securityEvent } from '../../services/audit.js';
import { ocpiTime, parseEvseUid, partyOf, toLocation, toSession, toTariff } from './format.js';
import { ocpiFetch } from './client.js';

const router = express.Router();
const ok = (res, data, msg = 'Success') => res.json({ data, status_code: 1000, status_message: msg, timestamp: ocpiTime() });
const err = (res, http, code, msg) => res.status(http).json({ status_code: code, status_message: msg, timestamp: ocpiTime() });
const base = () => `${config.publicApiUrl}/ocpi`;

function readToken(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Token ')) return null;
  const raw = h.slice(6).trim();
  // 2.2.1 sends the token base64-encoded; accept plain tokens from 2.1-era clients too.
  try {
    const d = Buffer.from(raw, 'base64').toString();
    if (/^[\x20-\x7e]+$/.test(d) && Buffer.from(d).toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) return d;
  } catch {
    /* plain */
  }
  return raw;
}

/** Token A (registration only) or token C (after handshake). */
async function auth(req, res, next) {
  const t = readToken(req);
  if (!t) return err(res, 401, 2000, 'Missing token');
  const partner = await RoamingPartner.findOne({ protocol: 'ocpi', $or: [{ tokenC: t }, { tokenA: t }] });
  if (!partner) {
    await securityEvent('ocpi_bad_token', { path: req.path }, req.ip);
    return err(res, 401, 2000, 'Unknown token');
  }
  req.partner = partner;
  req.registrationOnly = partner.tokenA === t && partner.tokenC !== t;
  if (req.registrationOnly && !req.path.includes('credentials') && !req.path.includes('versions') && req.path !== '/2.2.1' && req.path !== '/2.2.1/') {
    return err(res, 401, 2000, 'Registration token only allows credentials');
  }
  if (!partner.enabled && !req.path.includes('credentials')) return err(res, 403, 2000, 'Roaming with this partner is switched off');
  return next();
}

router.use(express.json({ limit: '1mb' }));
router.use(auth);

router.get('/versions', (_req, res) => ok(res, [{ version: '2.2.1', url: `${base()}/2.2.1` }]));

router.get('/2.2.1', (_req, res) =>
  ok(res, {
    version: '2.2.1',
    endpoints: [
      { identifier: 'credentials', role: 'SENDER', url: `${base()}/2.2.1/credentials` },
      { identifier: 'credentials', role: 'RECEIVER', url: `${base()}/2.2.1/credentials` },
      { identifier: 'locations', role: 'SENDER', url: `${base()}/2.2.1/locations` },
      { identifier: 'tariffs', role: 'SENDER', url: `${base()}/2.2.1/tariffs` },
      { identifier: 'sessions', role: 'SENDER', url: `${base()}/2.2.1/sessions` },
      { identifier: 'cdrs', role: 'SENDER', url: `${base()}/2.2.1/cdrs` },
      { identifier: 'tokens', role: 'RECEIVER', url: `${base()}/2.2.1/tokens` },
      { identifier: 'commands', role: 'RECEIVER', url: `${base()}/2.2.1/commands` },
      // eMSP receiver side for roaming OUT
      { identifier: 'cdrs', role: 'RECEIVER', url: `${base()}/2.2.1/emsp/cdrs` },
      { identifier: 'sessions', role: 'RECEIVER', url: `${base()}/2.2.1/emsp/sessions` },
    ],
  }));

// ------------------------------------------------------------- credentials (handshake)

async function ourCredentials(partner) {
  const tenants = await Tenant.find({ status: 'active' }).lean();
  const shared = partner.tenantsShared?.length ? tenants.filter((t) => partner.tenantsShared.some((x) => String(x) === String(t._id))) : tenants;
  return {
    token: partner.tokenC,
    url: `${base()}/versions`,
    roles: [
      ...shared.map((t) => ({ role: 'CPO', country_code: config.ocpi.countryCode, party_id: partyOf(t), business_details: { name: t.name } })),
      { role: 'EMSP', country_code: config.ocpi.countryCode, party_id: config.ocpi.platformPartyId, business_details: { name: 'ChargeX' } },
    ],
  };
}

async function discoverEndpoints(partner) {
  try {
    const versions = await ocpiFetch(partner, partner.versionsUrl);
    const v = (versions.data || []).find((x) => x.version === '2.2.1') || versions.data?.[0];
    if (!v) return;
    const details = await ocpiFetch(partner, v.url);
    const map = {};
    for (const e of details.data?.endpoints || []) {
      // keep the endpoint matching the role we talk to on their side
      if (!map[e.identifier] || e.role === 'RECEIVER') map[e.identifier] = e.url;
    }
    partner.endpoints = map;
  } catch (e) {
    logger.warn(`ocpi discover ${partner.name}: ${e.message}`);
  }
}

router.get('/2.2.1/credentials', async (req, res) => ok(res, await ourCredentials(req.partner)));

async function register(req, res, isUpdate) {
  const p = req.partner;
  const body = req.body || {};
  if (!body.token || !body.url) return err(res, 400, 2001, 'token and url are required');
  if (!isUpdate && p.status === 'registered' && !req.registrationOnly) return err(res, 405, 3000, 'Already registered; use PUT');
  const role = (body.roles || [])[0] || {};
  p.tokenB = body.token;
  p.versionsUrl = body.url;
  p.countryCode = role.country_code || p.countryCode;
  p.partyId = role.party_id || p.partyId;
  p.roles = (body.roles || []).map((r) => r.role);
  p.tokenC = randomToken(24);
  p.tokenA = undefined; // registration token is single-use
  p.status = 'registered';
  await discoverEndpoints(p);
  await p.save();
  return ok(res, await ourCredentials(p));
}

router.post('/2.2.1/credentials', (req, res) => register(req, res, false));
router.put('/2.2.1/credentials', (req, res) => register(req, res, true));
router.delete('/2.2.1/credentials', async (req, res) => {
  req.partner.status = 'pending';
  req.partner.tokenB = undefined;
  req.partner.tokenC = undefined;
  await req.partner.save();
  ok(res, null);
});

// ------------------------------------------------------------- locations / tariffs (SENDER)

async function sharedChargers(partner, extra = {}) {
  const q = { roamingEnabled: true, deletedAt: null, ...extra };
  if (partner.tenantsShared?.length) q.tenant = { $in: partner.tenantsShared };
  const active = await Tenant.find({ status: 'active' }).select('_id').lean();
  q.tenant = q.tenant ? { $in: q.tenant.$in.filter((t) => active.some((a) => String(a._id) === String(t))) } : { $in: active.map((a) => a._id) };
  return Charger.find(q).lean();
}

function paginate(req, res, items) {
  const offset = Number(req.query.offset || 0);
  const limit = Math.min(Number(req.query.limit || 50), 200);
  res.set('X-Total-Count', String(items.length));
  res.set('X-Limit', String(limit));
  if (offset + limit < items.length) res.set('Link', `<${base()}${req.path}?offset=${offset + limit}&limit=${limit}>; rel="next"`);
  return items.slice(offset, offset + limit);
}

async function buildLocations(partner, siteFilter) {
  const chargers = await sharedChargers(partner, siteFilter ? { site: siteFilter } : {});
  const bySite = new Map();
  for (const c of chargers) {
    const k = String(c.site);
    if (!bySite.has(k)) bySite.set(k, []);
    bySite.get(k).push(c);
  }
  const out = [];
  for (const [siteId, list] of bySite) {
    const site = await Site.findById(siteId).lean();
    const tenant = await Tenant.findById(site.tenant).lean();
    const tariff = await activeTariff(site.tenant, list[0].tariffKey);
    out.push(toLocation(site, list, tenant, tariff));
  }
  return out;
}

router.get('/2.2.1/locations', async (req, res) => {
  let locs = await buildLocations(req.partner);
  if (req.query.date_from) locs = locs.filter((l) => new Date(l.last_updated) >= new Date(req.query.date_from));
  ok(res, paginate(req, res, locs));
});

router.get('/2.2.1/locations/:locationId/:evseUid?/:connectorId?', async (req, res) => {
  const [loc] = await buildLocations(req.partner, req.params.locationId).catch(() => []);
  if (!loc) return err(res, 404, 2003, 'Unknown location');
  if (!req.params.evseUid) return ok(res, loc);
  const evse = loc.evses.find((e) => e.uid === req.params.evseUid);
  if (!evse) return err(res, 404, 2003, 'Unknown EVSE');
  if (!req.params.connectorId) return ok(res, evse);
  const c = evse.connectors.find((x) => x.id === req.params.connectorId);
  return c ? ok(res, c) : err(res, 404, 2003, 'Unknown connector');
});

router.get('/2.2.1/tariffs', async (req, res) => {
  const tenants = await Tenant.find(req.partner.tenantsShared?.length ? { _id: { $in: req.partner.tenantsShared } } : { status: 'active' }).lean();
  const out = [];
  for (const t of tenants) {
    const tariffs = await Tariff.find({ tenant: t._id, status: 'published' }).sort({ version: -1 }).lean();
    const latest = new Map();
    for (const tr of tariffs) if (!latest.has(tr.key)) latest.set(tr.key, tr);
    for (const tr of latest.values()) out.push(toTariff(t, tr, req.partner));
  }
  ok(res, paginate(req, res, out));
});

router.get('/2.2.1/sessions', async (req, res) => {
  const q = { 'roaming.partner': req.partner._id };
  if (req.query.date_from) q.updatedAt = { $gte: new Date(req.query.date_from) };
  const sessions = await Session.find(q).sort({ updatedAt: -1 }).limit(1000).lean();
  const tenants = new Map();
  const out = [];
  for (const s of sessions) {
    if (!tenants.has(String(s.tenant))) tenants.set(String(s.tenant), await Tenant.findById(s.tenant).lean());
    out.push(toSession(s, tenants.get(String(s.tenant))));
  }
  ok(res, paginate(req, res, out));
});

router.get('/2.2.1/cdrs', async (req, res) => {
  const cdrs = await Cdr.find({ partner: req.partner._id, direction: 'out' }).sort({ createdAt: -1 }).limit(1000).lean();
  ok(res, paginate(req, res, cdrs.map((c) => c.data)));
});

// ------------------------------------------------------------- tokens (RECEIVER)

router.get('/2.2.1/tokens/:cc/:pid/:uid', async (req, res) => {
  const t = await RoamingToken.findOne({ partner: req.partner._id, uid: req.params.uid }).lean();
  return t ? ok(res, t.raw) : err(res, 404, 2004, 'Unknown token');
});

router.put('/2.2.1/tokens/:cc/:pid/:uid', async (req, res) => {
  const b = req.body || {};
  if (!b.uid || b.uid !== req.params.uid) return err(res, 400, 2001, 'uid mismatch');
  await RoamingToken.updateOne(
    { partner: req.partner._id, uid: b.uid },
    { $set: { type: b.type, contractId: b.contract_id, issuer: b.issuer, valid: b.valid !== false, whitelist: b.whitelist || 'ALLOWED', lastUpdated: new Date(), raw: b } },
    { upsert: true },
  );
  ok(res, null);
});

router.patch('/2.2.1/tokens/:cc/:pid/:uid', async (req, res) => {
  const t = await RoamingToken.findOne({ partner: req.partner._id, uid: req.params.uid });
  if (!t) return err(res, 404, 2004, 'Unknown token');
  if ('valid' in req.body) t.valid = !!req.body.valid;
  if (req.body.whitelist) t.whitelist = req.body.whitelist;
  t.raw = { ...(t.raw || {}), ...req.body };
  t.lastUpdated = new Date();
  await t.save();
  return ok(res, null);
});

// ------------------------------------------------------------- commands (RECEIVER)

/** Token check for START_SESSION: known & valid, or supplied valid and not blocked here (ROM-02). */
async function tokenAllowed(partner, token) {
  if (!token?.uid) return false;
  const known = await RoamingToken.findOne({ partner: partner._id, uid: token.uid }).lean();
  if (known) return known.valid && !['NEVER'].includes(known.whitelist);
  if (token.valid === true && token.whitelist !== 'NEVER') {
    await RoamingToken.create({ partner: partner._id, uid: token.uid, type: token.type, contractId: token.contract_id, valid: true, whitelist: token.whitelist || 'ALLOWED', raw: token, lastUpdated: new Date() });
    return true;
  }
  return false;
}

router.post('/2.2.1/commands/:command', async (req, res) => {
  const { command } = req.params;
  const b = req.body || {};
  if (!b.response_url) return err(res, 400, 2001, 'response_url is required');
  const rec = await RoamingCommand.create({ partner: req.partner._id, command, request: b, responseUrl: b.response_url });
  const reject = async (result, message) => {
    rec.status = 'rejected';
    rec.result = result;
    await rec.save();
    return ok(res, { result, timeout: 0, message: [{ language: 'en', text: message }] });
  };

  if (command === 'START_SESSION') {
    if (!(await tokenAllowed(req.partner, b.token))) return reject('REJECTED', 'Token unknown or blocked');
    const { ocppId, evseId } = parseEvseUid(b.evse_uid || '');
    const charger = await Charger.findOne({ ocppId, roamingEnabled: true, deletedAt: null });
    if (!charger || String(charger.site) !== String(b.location_id)) return reject('REJECTED', 'Unknown location or EVSE');
    const conn = b.connector_id ? charger.connector(Number(b.connector_id)) : charger.connectors.find((c) => c.evseId === evseId);
    if (!conn) return reject('REJECTED', 'Unknown connector');
    try {
      const { session } = await createSession({
        ocppId, connectorNumber: conn.number, channel: 'roaming',
        roaming: { partner: req.partner._id, protocol: 'ocpi', tokenUid: b.token.uid, authRef: b.authorization_reference, responseUrl: b.response_url },
      });
      rec.session = session._id;
      rec.status = 'accepted';
      await rec.save();
      return ok(res, { result: 'ACCEPTED', timeout: config.charging.startTimeoutSec + 30 });
    } catch (e) {
      return reject(e.code === 'CONNECTOR_BUSY' ? 'REJECTED' : 'REJECTED', e.message);
    }
  }
  if (command === 'STOP_SESSION') {
    const s = await Session.findOne({ _id: b.session_id, 'roaming.partner': req.partner._id }).catch(() => null);
    if (!s) return reject('UNKNOWN_SESSION', 'Unknown session');
    rec.session = s._id;
    rec.status = 'accepted';
    await rec.save();
    res.json({ data: { result: 'ACCEPTED', timeout: 30 }, status_code: 1000, timestamp: ocpiTime() });
    const r = await requestStop(s, { by: `ocpi:${req.partner.name}`, reason: 'roaming_stop' });
    await ocpiFetch(req.partner, b.response_url, { method: 'POST', body: { result: r.ok || r.alreadyStopping ? 'ACCEPTED' : 'FAILED' } }).catch(() => {});
    return undefined;
  }
  if (command === 'UNLOCK_CONNECTOR') {
    const { ocppId } = parseEvseUid(b.evse_uid || '');
    const charger = await Charger.findOne({ ocppId, roamingEnabled: true });
    const conn = charger?.connector(Number(b.connector_id));
    if (!conn) return reject('REJECTED', 'Unknown connector');
    rec.status = 'accepted';
    await rec.save();
    res.json({ data: { result: 'ACCEPTED', timeout: 30 }, status_code: 1000, timestamp: ocpiTime() });
    const r = await sendCommand(charger, 'UnlockConnector', { evseId: conn.evseId, connectorId: conn.connectorId }, { reason: `ocpi unlock ${req.partner.name}` });
    await ocpiFetch(req.partner, b.response_url, { method: 'POST', body: { result: r.status === 'Accepted' ? 'ACCEPTED' : 'FAILED' } }).catch(() => {});
    return undefined;
  }
  return reject('NOT_SUPPORTED', `${command} not supported`);
});

// ------------------------------------------------------------- eMSP receivers (roaming OUT)

router.put('/2.2.1/emsp/sessions/:cc/:pid/:id', async (req, res) => {
  logger.info(`partner session update ${req.partner.name} ${req.params.id} ${req.body?.status}`);
  ok(res, null);
});

router.post('/2.2.1/emsp/commands/result/:id', async (req, res) => {
  await RoamingCommand.updateOne({ _id: req.params.id, partner: req.partner._id }, { $set: { status: 'result_sent', result: req.body?.result } }).catch(() => {});
  ok(res, null);
});

router.post('/2.2.1/emsp/cdrs', async (req, res) => {
  const b = req.body || {};
  if (!b.id) return err(res, 400, 2001, 'CDR id required');
  try {
    await Cdr.create({
      partner: req.partner._id, direction: 'in', cdrId: `${req.partner._id}:${b.id}`, data: b, status: 'received',
      totalCostPaise: Math.round((b.total_cost?.incl_vat || 0) * 100), energyWh: Math.round((b.total_energy || 0) * 1000), month: String(b.end_date_time || new Date().toISOString()).slice(0, 7),
    });
  } catch (e) {
    if (e.code !== 11000) throw e;
  }
  ok(res, null);
});

router.use((e, _req, res, _next) => {
  logger.error('ocpi error', e);
  err(res, 500, 3000, 'Server error');
});

export default router;
