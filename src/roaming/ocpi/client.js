// Outbound OCPI calls to partners (as CPO: push sessions/CDRs/locations; as eMSP: pull locations, send commands).
import { Cdr, RoamingPartner, Session, Site, Tenant, Charger, Tariff } from '../../models/index.js';
import { logger } from '../../lib/logger.js';
import { events } from '../../services/events.js';
import { raiseAlert } from '../../services/alerts.js';
import { config } from '../../config.js';
import { toCdr, toLocation, toSession, partyOf } from './format.js';

const enc = (t) => Buffer.from(t).toString('base64');
const BACKOFF = [30, 120, 600, 1800, 3600, 6 * 3600];

export async function ocpiFetch(partner, url, { method = 'GET', body } = {}) {
  if (!url) throw new Error('Partner endpoint not configured');
  if (!partner.tokenB) throw new Error('Partner not registered (no token)');
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Token ${enc(partner.tokenB)}`, 'Content-Type': 'application/json', 'X-Request-ID': String(Date.now()), 'OCPI-from-country-code': config.ocpi.countryCode, 'OCPI-from-party-id': config.ocpi.platformPartyId },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || (json.status_code && json.status_code >= 2000)) throw new Error(`OCPI ${r.status} ${json.status_message || ''}`.trim());
  return json;
}

const endpoint = (partner, id) => partner.endpoints?.get?.(id) || partner.endpoints?.[id];

/** Create a CDR record when a roaming session is billed; pushed (with retries) by the job (ROM-03). */
export async function createCdrForSession(s) {
  if (s.channel !== 'roaming' || !s.roaming?.partner) return null;
  const [tenant, site, tariff] = await Promise.all([Tenant.findById(s.tenant).lean(), Site.findById(s.site).lean(), Tariff.findById(s.tariffId).lean()]);
  const data = toCdr(s, tenant, site, tariff);
  try {
    return await Cdr.create({ partner: s.roaming.partner, tenant: s.tenant, session: s._id, cdrId: data.id, data, totalCostPaise: s.costs.totalPaise, energyWh: s.energyWh, month: new Date(s.endedAt || Date.now()).toISOString().slice(0, 7) });
  } catch (e) {
    if (e.code === 11000) return null;
    throw e;
  }
}

export async function pushPendingCdrs() {
  const due = await Cdr.find({ direction: 'out', status: { $in: ['pending', 'failed'] }, nextAttemptAt: { $lte: new Date() } }).limit(25);
  for (const cdr of due) {
    const partner = await RoamingPartner.findById(cdr.partner);
    if (!partner?.enabled) continue;
    try {
      await ocpiFetch(partner, endpoint(partner, 'cdrs'), { method: 'POST', body: cdr.data });
      cdr.status = 'sent';
      cdr.lastError = undefined;
    } catch (e) {
      cdr.attempts += 1;
      cdr.status = 'failed';
      cdr.lastError = e.message;
      cdr.nextAttemptAt = new Date(Date.now() + (BACKOFF[Math.min(cdr.attempts - 1, BACKOFF.length - 1)]) * 1000);
      if (cdr.attempts === 3) await raiseAlert({ tenant: cdr.tenant, type: 'roaming_cdr', message: `CDR ${cdr.cdrId} to ${partner.name} failing: ${e.message}`, dedupeKey: `cdr:${cdr._id}` });
    }
    await cdr.save();
  }
  return due.length;
}

async function pushSession(s) {
  if (s.channel !== 'roaming' || !s.roaming?.partner) return;
  const partner = await RoamingPartner.findById(s.roaming.partner);
  const url = endpoint(partner || {}, 'sessions');
  if (!partner?.enabled || !url) return;
  const tenant = await Tenant.findById(s.tenant).lean();
  const obj = toSession(s, tenant);
  await ocpiFetch(partner, `${url}/${obj.country_code}/${obj.party_id}/${obj.id}`, { method: 'PUT', body: obj }).catch((e) => logger.warn(`ocpi session push: ${e.message}`));
}

/** Async command result to the eMSP's response_url (START_SESSION etc.). */
async function sendCommandResult(s) {
  const url = s.roaming?.responseUrl;
  if (!url || s.roaming?.resultSent) return;
  const started = ['CHARGING', 'STOPPING', 'COMPLETED', 'BILLED', 'INTERRUPTED'].includes(s.state);
  const failed = ['FAILED', 'CANCELLED'].includes(s.state);
  if (!started && !failed) return;
  const partner = await RoamingPartner.findById(s.roaming.partner);
  await Session.updateOne({ _id: s._id }, { $set: { 'roaming.resultSent': true } });
  await ocpiFetch(partner, url, { method: 'POST', body: { result: started ? 'ACCEPTED' : s.failureReason === 'connector_taken' ? 'EVSE_OCCUPIED' : 'FAILED' } }).catch((e) => logger.warn(`ocpi command result: ${e.message}`));
}

/** Push a location update (status change, roaming on/off) to every partner that has a locations endpoint. */
export async function pushLocation(chargerId) {
  const ch = await Charger.findById(chargerId).lean();
  if (!ch) return;
  const [site, tenant, chargers] = await Promise.all([Site.findById(ch.site).lean(), Tenant.findById(ch.tenant).lean(), Charger.find({ site: ch.site, deletedAt: null }).lean()]);
  const partners = await RoamingPartner.find({ protocol: 'ocpi', status: 'registered', enabled: true });
  for (const p of partners) {
    const url = endpoint(p, 'locations');
    if (!url) continue;
    if (p.tenantsShared?.length && !p.tenantsShared.some((t) => String(t) === String(ch.tenant))) continue;
    const loc = toLocation(site, chargers.filter((c) => c.roamingEnabled || String(c._id) === String(ch._id)), tenant);
    await ocpiFetch(p, `${url}/${loc.country_code}/${partyOf(tenant)}/${loc.id}`, { method: 'PUT', body: loc }).catch((e) => logger.debug(`ocpi location push ${p.name}: ${e.message}`));
  }
}

/** eMSP role (roaming OUT): pull a partner CPO's locations so our drivers can see "Partner network" chargers. */
export async function pullPartnerLocations(partner) {
  const { PartnerLocation } = await import('../../models/index.js');
  const url = endpoint(partner, 'locations');
  const json = await ocpiFetch(partner, url);
  let n = 0;
  for (const loc of json.data || []) {
    await PartnerLocation.updateOne(
      { partner: partner._id, locationId: loc.id },
      { $set: { name: loc.name, address: loc.address, city: loc.city, coordinates: { lat: Number(loc.coordinates?.latitude), lng: Number(loc.coordinates?.longitude) }, evses: loc.evses, raw: loc, lastUpdated: new Date() } },
      { upsert: true },
    );
    n += 1;
  }
  return n;
}

export function attachRoamingListeners() {
  events.on('roaming:session', (s) => {
    if (s.channel !== 'roaming') return;
    sendCommandResult(s).catch(() => {});
    pushSession(s).catch(() => {});
  });
  events.on('session:billed', (s) => {
    if (s.channel !== 'roaming') return;
    pushSession(s).catch(() => {});
    createCdrForSession(s).then(() => pushPendingCdrs()).catch((e) => logger.warn(`cdr create: ${e.message}`));
  });
  events.on('charger', (e) => {
    if (e.ocppId) pushLocation(e.chargerId).catch(() => {});
  });
}
