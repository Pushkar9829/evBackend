import express from 'express';
import bcrypt from 'bcryptjs';
import { Charger, Complaint, DataRequest, Fleet, Invoice, Notification, PartnerLocation, RoamingCommand, RoamingPartner, Session, Site, Tariff, Tenant, User, nextSeq } from '../models/index.js';
import { config } from '../config.js';
import { parse, phoneSchema, z } from '../lib/validate.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { randomToken, randomId } from '../lib/util.js';
import { requireDriver } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { anonymiseUser, exportData, openRequest } from '../services/privacy.js';
import { IssuedCertificate, issueContractCertificate } from '../services/pki.js';
import { getSettings } from '../services/settings.js';
import { sessionView } from './sessions.js';
import { publicCharger } from './public.js';
import { ocpiFetch } from '../roaming/ocpi/client.js';
import { CONNECTOR_TYPES } from '../models/charger.js';

const router = express.Router();
router.use(requireDriver);

router.get('/', (req, res) => res.json({ user: req.user.toPublic() }));

router.patch('/', async (req, res) => {
  const b = parse(z.object({
    name: z.string().max(80).optional(),
    email: z.string().email().optional(),
    language: z.enum(['en', 'hi']).optional(),
    gstin: z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/, 'Enter a valid GSTIN').or(z.literal('')).optional(),
    businessName: z.string().max(120).optional(),
    notificationPrefs: z.object({ push: z.boolean(), sms: z.boolean(), whatsapp: z.boolean(), email: z.boolean() }).partial().optional(),
    pushToken: z.string().optional(),
  }), req.body);
  if (b.pushToken) {
    req.user.pushTokens = [...(req.user.pushTokens || []).filter((t) => t.token !== b.pushToken), { token: b.pushToken, platform: 'web', valid: true }];
    delete b.pushToken;
  }
  if (b.notificationPrefs) b.notificationPrefs = { ...req.user.notificationPrefs?.toObject?.(), ...b.notificationPrefs };
  Object.assign(req.user, b);
  await req.user.save();
  res.json({ user: req.user.toPublic() });
});

// ------------------------------------------------------------- vehicles & favourites

router.post('/vehicles', async (req, res) => {
  const b = parse(z.object({ label: z.string().max(40).optional(), make: z.string().max(40).optional(), model: z.string().max(40).optional(), vehicleType: z.enum(['2W', '3W', 'car', 'bus']), connectorTypes: z.array(z.enum(CONNECTOR_TYPES)).default([]), batteryKwh: z.number().positive().max(500).optional(), registration: z.string().max(20).optional() }), req.body);
  req.user.vehicles.push(b);
  await req.user.save();
  res.status(201).json({ vehicles: req.user.vehicles });
});

/** Plug & Charge: issue an ISO 15118 contract (eMAID + certificate) for a vehicle. Billing is postpaid. */
router.post('/vehicles/:vid/pnc', async (req, res) => {
  const v = req.user.vehicles.id(req.params.vid);
  if (!v) throw notFound('Vehicle not found.');
  if (!(req.user.autopay?.status === 'active' || req.user.fleet)) throw badRequest('AUTOPAY_REQUIRED', 'Plug & Charge bills after the session: set up UPI Autopay or join a fleet first.');
  if (v.pnc?.emaid && !v.pnc.revokedAt) throw conflict('PNC_ACTIVE', 'Plug & Charge is already on for this vehicle.');
  const c = await issueContractCertificate(req.user);
  v.pnc = { emaid: c.emaid, certSerial: c.hash.serialNumber, issuedAt: new Date() };
  await req.user.save();
  await audit(req, { action: 'driver.pnc_enable', entity: 'User', entityId: req.user._id, after: { emaid: c.emaid, vehicle: v.label || v.model } });
  // The certificate + key are provisioned into the car (OEM backend / CCP). Shown once.
  res.status(201).json({ emaid: c.emaid, certificateChain: c.chain, privateKey: c.key, hashData: c.hash, note: 'Provision this contract into the vehicle via its OEM backend or a Contract Certificate Pool. The private key is shown once.' });
});

router.delete('/vehicles/:vid/pnc', async (req, res) => {
  const v = req.user.vehicles.id(req.params.vid);
  if (!v?.pnc?.emaid) throw notFound('Plug & Charge is not on for this vehicle.');
  await IssuedCertificate.updateMany({ emaid: v.pnc.emaid, revokedAt: null }, { $set: { revokedAt: new Date() } });
  v.pnc.revokedAt = new Date();
  await req.user.save();
  await audit(req, { action: 'driver.pnc_revoke', entity: 'User', entityId: req.user._id, after: { emaid: v.pnc.emaid } });
  res.json({ ok: true });
});

router.delete('/vehicles/:vid', async (req, res) => {
  req.user.vehicles = req.user.vehicles.filter((v) => String(v._id) !== req.params.vid);
  await req.user.save();
  res.json({ vehicles: req.user.vehicles });
});

router.get('/favourites', async (req, res) => {
  const chargers = await Charger.find({ _id: { $in: req.user.favourites }, deletedAt: null }).lean();
  res.json({ chargers: await Promise.all(chargers.map((c) => publicCharger(c))) });
});

router.post('/favourites/:chargerId', async (req, res) => {
  if (!req.user.favourites.some((f) => String(f) === req.params.chargerId)) req.user.favourites.push(req.params.chargerId);
  await req.user.save();
  res.json({ favourites: req.user.favourites });
});

router.delete('/favourites/:chargerId', async (req, res) => {
  req.user.favourites = req.user.favourites.filter((f) => String(f) !== req.params.chargerId);
  await req.user.save();
  res.json({ favourites: req.user.favourites });
});

// ------------------------------------------------------------- history

router.get('/home', async (req, res) => {
  const active = await Session.findOne({ driver: req.user._id, state: { $in: ['CREATED', 'PAID', 'STARTING', 'CHARGING', 'STOPPING', 'INTERRUPTED'] } }).sort({ createdAt: -1 });
  const last = req.user.lastChargerId ? await Charger.findById(req.user.lastChargerId).lean() : null;
  const settings = await getSettings();
  res.json({
    active: active ? await sessionView(active, 'owner') : null,
    chargeAgain: last ? { charger: await publicCharger(last), lastAmountPaise: req.user.lastAmountPaise } : null,
    banner: settings.maintenanceBanner?.active ? settings.maintenanceBanner.message : null,
  });
});

router.get('/sessions', async (req, res) => {
  const sessions = await Session.find({ driver: req.user._id, state: { $ne: 'CREATED' } }).sort({ createdAt: -1 }).limit(200).populate('charger', 'label ocppId').populate('site', 'name').lean();
  const months = {};
  for (const s of sessions) {
    const k = new Date(s.createdAt).toISOString().slice(0, 7);
    months[k] = months[k] || { month: k, totalPaise: 0, energyWh: 0, sessions: [] };
    months[k].totalPaise += s.costs?.totalPaise || 0;
    months[k].energyWh += s.energyWh || 0;
    months[k].sessions.push({ id: s._id, state: s.state, charger: s.charger?.label || s.charger?.ocppId, site: s.site?.name, energyWh: s.energyWh, totalPaise: s.costs?.totalPaise || 0, refundPaise: s.refundPaise, prepaidPaise: s.prepaidPaise, createdAt: s.createdAt, failureReason: s.failureReason, invoice: s.invoice });
  }
  res.json({ months: Object.values(months) });
});

router.get('/invoices', async (req, res) => {
  const ids = (await Session.find({ driver: req.user._id }).select('_id').lean()).map((s) => s._id);
  res.json({ invoices: await Invoice.find({ session: { $in: ids }, status: 'issued' }).sort({ issuedAt: -1 }).lean() });
});

router.get('/complaints', async (req, res) => {
  res.json({ complaints: await Complaint.find({ driver: req.user._id }).sort({ createdAt: -1 }).lean() });
});

router.get('/notifications', async (req, res) => {
  res.json({ notifications: await Notification.find({ user: req.user._id, channel: 'inapp' }).sort({ createdAt: -1 }).limit(50).lean() });
});

// ------------------------------------------------------------- payments: saved methods / UPI Autopay

router.post('/saved-methods', async (req, res) => {
  // In production the gateway returns a token after a tokenisation flow; we never store card data (PAY-14).
  const b = parse(z.object({ kind: z.enum(['upi', 'card']), label: z.string().max(40) }), req.body);
  req.user.savedMethods.push({ kind: b.kind, label: b.label, gatewayToken: `tok_mock_${randomId(6)}`, addedAt: new Date() });
  await req.user.save();
  res.status(201).json({ savedMethods: req.user.savedMethods.map((m) => ({ id: m._id, kind: m.kind, label: m.label })) });
});

router.get('/saved-methods', (req, res) => res.json({ savedMethods: req.user.savedMethods.map((m) => ({ id: m._id, kind: m.kind, label: m.label })) }));

router.post('/autopay', async (req, res) => {
  const b = parse(z.object({ maxPaise: z.number().int().min(10000).max(500000) }), req.body);
  req.user.autopay = { mandateId: `mdt_mock_${randomId(6)}`, status: 'active', maxPaise: b.maxPaise };
  await req.user.save();
  res.json({ autopay: req.user.autopay });
});

router.delete('/autopay', async (req, res) => {
  req.user.autopay = { status: 'revoked' };
  await req.user.save();
  res.json({ autopay: req.user.autopay });
});

router.post('/rfid', async (req, res) => {
  const b = parse(z.object({ uid: z.string().min(4).max(36) }), req.body);
  if (await User.exists({ 'rfidCards.uid': b.uid })) throw conflict('RFID_IN_USE', 'This card is already linked.');
  req.user.rfidCards.push({ uid: b.uid, addedAt: new Date() });
  await req.user.save();
  res.json({ rfidCards: req.user.rfidCards });
});

// ------------------------------------------------------------- delete account (ACC-08)

router.delete('/', async (req, res) => {
  const id = req.user._id;
  const result = await anonymiseUser(req.user);
  await DataRequest.create({ user: id, kind: 'delete', source: 'self_service', status: 'completed', completedAt: new Date(), result, history: [{ status: 'completed', at: new Date(), note: 'self-service' }], notes: 'Profile anonymised; invoices kept for the tax period without name/phone' });
  await audit(req, { action: 'driver.delete_account', entity: 'User', entityId: id, after: result });
  res.json({ ok: true });
});

/** Download everything we hold about the driver (DPDP right of access). */
router.get('/data-export', async (req, res) => {
  const data = await exportData({ userId: req.user._id });
  await DataRequest.create({ user: req.user._id, kind: 'export', source: 'self_service', status: 'completed', completedAt: new Date(), history: [{ status: 'completed', at: new Date(), note: 'self-service export' }] });
  res.setHeader('Content-Disposition', 'attachment; filename="chargex-my-data.json"');
  res.json(data);
});

router.get('/data-requests', async (req, res) => {
  res.json({ requests: await DataRequest.find({ user: req.user._id }).sort({ createdAt: -1 }).select('kind status source createdAt dueAt completedAt notes').lean() });
});

router.post('/data-requests', async (req, res) => {
  const b = parse(z.object({ kind: z.enum(['delete', 'export']), reason: z.string().max(500).optional() }), req.body);
  const r = await openRequest({ user: req.user, kind: b.kind, source: 'driver_request', reason: b.reason });
  res.status(201).json({ request: r });
});

// ------------------------------------------------------------- Host mode (Individual Hosts, Phase 2)

router.post('/host', async (req, res) => {
  if (req.user.hostTenant) throw conflict('ALREADY_HOST', 'You already have host mode.');
  const b = parse(z.object({
    displayName: z.string().min(2).max(80),
    address: z.string().min(3).max(200),
    city: z.string().max(60),
    lat: z.number(),
    lng: z.number(),
    connectorType: z.enum(CONNECTOR_TYPES).default('Type2'),
    maxPowerKw: z.number().positive().max(60).default(7.4),
    pricePaisePerKwh: z.number().int().min(500).max(5000).optional(),
    protocol: z.enum(['ocpp2.0.1', 'ocpp1.6']).default('ocpp1.6'),
  }), req.body);
  const settings = await getSettings();
  const slug = `host-${randomId(4)}`;
  const tenant = await Tenant.create({ name: b.displayName, slug, type: 'host', status: 'active', contact: { name: req.user.name, phone: req.user.phone }, address: b.address, invoicePrefix: `H${slug.slice(-4).toUpperCase()}` });
  req.user.memberships.push({ tenant: tenant._id, role: 'individual_host' });
  req.user.hostTenant = tenant._id;
  await req.user.save();
  const site = await Site.create({ tenant: tenant._id, name: b.displayName, address: b.address, city: b.city, location: { lat: b.lat, lng: b.lng } });
  await Tariff.create({ tenant: tenant._id, key: 'default', name: 'Host price', version: 1, status: 'published', energyPaisePerKwh: b.pricePaisePerKwh || settings.hostSuggestedPricePaisePerKwh, publishedAt: new Date() });
  const password = randomToken(12);
  const ocppId = `HOST-${String(await nextSeq('host-charger')).padStart(5, '0')}`;
  const charger = await Charger.create({ tenant: tenant._id, site: site._id, ocppId, label: b.displayName, passwordHash: await bcrypt.hash(password, 8), protocol: b.protocol, tariffKey: 'default', connectors: [{ number: 1, evseId: 1, connectorId: 1, type: b.connectorType, powerType: 'AC', maxPowerKw: b.maxPowerKw, vehicleTypes: ['2W', '3W', 'car'] }] });
  await audit(req, { action: 'host.signup', entity: 'Tenant', entityId: tenant._id, tenant: tenant._id });
  res.status(201).json({
    tenant: { id: tenant._id, name: tenant.name },
    charger: { id: charger._id, ocppId },
    setup: { serverUrl: `${config.publicApiUrl.replace(/^http/, 'ws')}/ocpp`, chargerId: ocppId, password, note: 'Enter these in the charger or smart socket settings. Shown once.' },
    suggestedPricePaisePerKwh: settings.hostSuggestedPricePaisePerKwh,
  });
});

router.get('/host', async (req, res) => {
  if (!req.user.hostTenant) return res.json({ host: null });
  const t = await Tenant.findById(req.user.hostTenant).lean();
  const chargers = await Charger.find({ tenant: t._id, deletedAt: null }).lean();
  const since = new Date(Date.now() - 30 * 86400_000);
  const sessions = await Session.find({ tenant: t._id, state: 'BILLED', endedAt: { $gte: since } }).lean();
  const earnings = sessions.reduce((s, x) => s + (x.tenantSharePaise || 0), 0);
  const tariff = await Tariff.findOne({ tenant: t._id, status: 'published' }).sort({ version: -1 }).lean();
  return res.json({
    host: { id: t._id, name: t.name },
    chargers: chargers.map((c) => ({ id: c._id, ocppId: c.ocppId, online: c.online, connectors: c.connectors.map((x) => ({ number: x.number, status: x.status })), uptimePct: c.uptime?.scorePct })),
    last30: { sessions: sessions.length, energyWh: sessions.reduce((s, x) => s + x.energyWh, 0), earningsPaise: earnings },
    pricePaisePerKwh: tariff?.energyPaisePerKwh,
  });
});

router.patch('/host/price', async (req, res) => {
  if (!req.user.hostTenant) throw forbidden('Host mode is not enabled.');
  const b = parse(z.object({ pricePaisePerKwh: z.number().int().min(500).max(5000) }), req.body);
  const last = await Tariff.findOne({ tenant: req.user.hostTenant, key: 'default' }).sort({ version: -1 });
  const t = await Tariff.create({ ...last.toObject(), _id: undefined, version: last.version + 1, energyPaisePerKwh: b.pricePaisePerKwh, status: 'published', publishedAt: new Date(), activeFrom: new Date(), createdAt: undefined, updatedAt: undefined });
  await Tariff.updateOne({ _id: last._id }, { $set: { status: 'archived' } });
  await audit(req, { action: 'tariff.publish', entity: 'Tariff', entityId: t._id, tenant: req.user.hostTenant, before: { price: last.energyPaisePerKwh }, after: { price: t.energyPaisePerKwh }, reason: 'host price change' });
  res.json({ pricePaisePerKwh: t.energyPaisePerKwh, version: t.version });
});

// ------------------------------------------------------------- Fleet manager (Phase 2)

router.post('/fleet', async (req, res) => {
  const b = parse(z.object({ name: z.string().min(2).max(80), gstin: z.string().optional(), billingEmail: z.string().email().optional(), creditLimitPaise: z.number().int().min(10000).max(100_000_000).default(1_000_000) }), req.body);
  if (req.user.fleet) throw conflict('IN_FLEET', 'You are already part of a fleet.');
  const fleet = await Fleet.create({ ...b, managers: [req.user._id], drivers: [{ user: req.user._id, active: true }] });
  req.user.fleet = fleet._id;
  await req.user.save();
  res.status(201).json({ fleet });
});

async function myManagedFleet(req) {
  const fleet = req.user.fleet && (await Fleet.findById(req.user.fleet));
  if (!fleet || !fleet.managers.some((m) => String(m) === String(req.user._id))) throw forbidden('You are not a fleet manager.');
  return fleet;
}

router.get('/fleet', async (req, res) => {
  if (!req.user.fleet) return res.json({ fleet: null });
  const fleet = await Fleet.findById(req.user.fleet).populate('drivers.user', 'name phone').lean();
  const isManager = fleet.managers.some((m) => String(m) === String(req.user._id));
  const monthStart = new Date(new Date().toISOString().slice(0, 7) + '-01T00:00:00Z');
  const sessions = isManager ? await Session.find({ fleet: fleet._id, state: 'BILLED', endedAt: { $gte: monthStart } }).populate('driver', 'name phone').lean() : [];
  return res.json({ fleet, isManager, month: { sessions: sessions.length, totalPaise: sessions.reduce((s, x) => s + x.costs.totalPaise, 0) }, recent: sessions.slice(0, 20).map((s) => ({ id: s._id, driver: s.driver?.name || s.driver?.phone, totalPaise: s.costs.totalPaise, energyWh: s.energyWh, endedAt: s.endedAt })) });
});

router.post('/fleet/drivers', async (req, res) => {
  const fleet = await myManagedFleet(req);
  const b = parse(z.object({ phone: phoneSchema, name: z.string().max(80).optional(), spendLimitPaise: z.number().int().min(0).optional() }), req.body);
  let u = await User.findOne({ phone: b.phone });
  if (!u) u = await User.create({ phone: b.phone, name: b.name });
  if (u.fleet && String(u.fleet) !== String(fleet._id)) throw conflict('IN_OTHER_FLEET', 'This driver belongs to another fleet.');
  u.fleet = fleet._id;
  await u.save();
  fleet.drivers = fleet.drivers.filter((d) => String(d.user) !== String(u._id));
  fleet.drivers.push({ user: u._id, spendLimitPaise: b.spendLimitPaise, active: true });
  await fleet.save();
  res.status(201).json({ fleet });
});

router.patch('/fleet/drivers/:userId', async (req, res) => {
  const fleet = await myManagedFleet(req);
  const b = parse(z.object({ spendLimitPaise: z.number().int().min(0).optional(), active: z.boolean().optional() }), req.body);
  const d = fleet.drivers.find((x) => String(x.user) === req.params.userId);
  if (!d) throw notFound('Driver not in fleet.');
  Object.assign(d, b);
  await fleet.save();
  res.json({ fleet });
});

router.post('/fleet/vehicles', async (req, res) => {
  const fleet = await myManagedFleet(req);
  const b = parse(z.object({ registration: z.string().min(4).max(20), vehicleType: z.enum(['2W', '3W', 'car', 'bus']), label: z.string().max(40).optional() }), req.body);
  fleet.vehicles.push(b);
  await fleet.save();
  res.status(201).json({ fleet });
});

// ------------------------------------------------------------- Partner network (roaming OUT / eMSP, Phase 4)

router.post('/partner-sessions', async (req, res) => {
  const b = parse(z.object({ locationId: z.string(), evseUid: z.string(), connectorId: z.string().optional() }), req.body);
  if (req.user.autopay?.status !== 'active') throw badRequest('AUTOPAY_REQUIRED', 'Set up UPI Autopay to charge on partner networks; you are billed after the session.');
  const loc = await PartnerLocation.findById(b.locationId);
  if (!loc) throw notFound('Partner location not found.');
  const partner = await RoamingPartner.findById(loc.partner);
  if (!partner?.enabled) throw badRequest('PARTNER_DISABLED', 'This partner network is unavailable.');
  const uid = `CHX${String(req.user._id).slice(-10).toUpperCase()}`;
  const cmd = await RoamingCommand.create({ partner: partner._id, command: 'START_SESSION', status: 'received', request: { locationId: loc.locationId, evseUid: b.evseUid, user: req.user._id } });
  const body = {
    response_url: `${config.publicApiUrl}/ocpi/2.2.1/emsp/commands/result/${cmd._id}`,
    token: { country_code: config.ocpi.countryCode, party_id: config.ocpi.platformPartyId, uid, type: 'APP_USER', contract_id: uid, issuer: 'ChargeX', valid: true, whitelist: 'ALLOWED', last_updated: new Date().toISOString() },
    location_id: loc.locationId,
    evse_uid: b.evseUid,
    connector_id: b.connectorId,
  };
  const url = partner.endpoints?.get?.('commands');
  try {
    const r = await ocpiFetch(partner, `${url}/START_SESSION`, { method: 'POST', body });
    cmd.status = r.data?.result === 'ACCEPTED' ? 'accepted' : 'rejected';
    cmd.result = r.data?.result;
  } catch (e) {
    cmd.status = 'rejected';
    cmd.result = e.message;
  }
  await cmd.save();
  res.json({ command: cmd._id, status: cmd.status, result: cmd.result });
});

export default router;
