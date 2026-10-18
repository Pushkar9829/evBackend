import express from 'express';
import { Charger, Content, PartnerLocation, Site, Tenant } from '../models/index.js';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { escapeRegex } from '../lib/util.js';
import { getSettings } from '../services/settings.js';
import { activeTariff, estimateForAmount } from '../services/tariffs.js';
import { isOnline } from '../ocpp/commands.js';
import { optionalAuth } from '../middleware/auth.js';
import { parse, phoneSchema, z } from '../lib/validate.js';
import { requestOtp, verifyOtp } from '../services/otp.js';
import { exportData, openRequest } from '../services/privacy.js';
import { planRoute } from '../services/routePlanner.js';
import { DataRequest } from '../models/index.js';

const router = express.Router();
export const PRESET_AMOUNTS = [10000, 20000, 50000];

const km = (a, b) => {
  if (!a || !b || a.lat === undefined || b.lat === undefined) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)) * 10) / 10;
};

/** What a driver sees for one connector. Offline chargers never show Available (DIS-02). */
export function displayStatus(charger, c) {
  if (!charger.online || !isOnline(charger.ocppId)) return 'Offline';
  if (!charger.inService) return 'Unavailable';
  if (c.status === 'Available' && c.activeSession) return 'Occupied';
  return c.status;
}

export async function publicCharger(ch, { site, tenant, origin } = {}) {
  const s = site || (await Site.findById(ch.site).lean());
  const t = tenant || (await Tenant.findById(ch.tenant).select('name slug pricesIncludeGst branding').lean());
  const tariff = await activeTariff(ch.tenant, ch.tariffKey);
  const connectors = ch.connectors.map((c) => ({
    number: c.number,
    type: c.type,
    powerType: c.powerType,
    maxPowerKw: c.maxPowerKw,
    vehicleTypes: c.vehicleTypes,
    status: displayStatus(ch, c),
  }));
  const usable = connectors.some((c) => c.status === 'Available' || c.status === 'Occupied');
  return {
    id: ch._id,
    ocppId: ch.ocppId,
    label: ch.label || ch.ocppId,
    operator: t?.name,
    site: s && { id: s._id, name: s.name, address: s.address, city: s.city, location: s.location, photos: s.photos, timings: s.timings, amenities: s.amenities, howToReach: s.howToReach },
    distanceKm: origin ? km(origin, s?.location) : null,
    connectors,
    online: ch.online,
    working: usable,
    price: tariff && {
      tariffVersion: tariff.version,
      energyPaisePerKwh: tariff.energyPaisePerKwh,
      sessionFeePaise: tariff.sessionFeePaise,
      timePaisePerMin: tariff.timePaisePerMin,
      idle: tariff.idle,
      tod: tariff.tod,
      gstIncluded: !!t?.pricesIncludeGst,
      gstRatePct: config.gstRateBps / 100,
    },
    lastSuccessfulChargeAt: ch.lastSuccessfulChargeAt,
    uptimePct: ch.uptime?.scorePct ?? 100,
    rating: ch.rating,
    photos: ch.photos,
    roaming: ch.roamingEnabled,
  };
}

router.get('/config', async (_req, res) => {
  const s = await getSettings();
  res.json({
    maintenanceBanner: s.maintenanceBanner?.active ? s.maintenanceBanner.message : null,
    paymentsPaused: s.pauseNewPayments || s.gatewayDown,
    paymentsPausedReason: s.pauseReason,
    minAppVersion: s.minAppVersion,
    supportPhone: s.supportPhone,
    supportEmail: s.supportEmail,
    presetAmountsPaise: PRESET_AMOUNTS,
    minAmountPaise: config.payments.minAmountPaise,
    maxAmountPaise: config.payments.maxAmountPaise,
    gstRatePct: config.gstRateBps / 100,
    languages: ['en', 'hi'],
    paymentProvider: config.payments.provider,
    demoOtp: !!config.otp.demoCode,
    plugInWindowSec: config.charging.plugInWindowSec,
  });
});

router.get('/chargers', optionalAuth, async (req, res) => {
  const { lat, lng, radiusKm = 50, connector, powerType, vehicle, q, brand } = req.query;
  const onlyAvailable = req.query.available !== 'false'; // filter on by default (UX 1.3)
  const activeTenants = await Tenant.find({ status: 'active' }).select('_id').lean();
  let tenantIds = activeTenants.map((t) => String(t._id));
  if (brand) {
    const b = await Tenant.findOne({ slug: brand }).lean();
    if (b?.branding?.visibleTenantIds?.length) tenantIds = tenantIds.filter((id) => b.branding.visibleTenantIds.some((v) => String(v) === id) || id === String(b._id));
  }
  const filter = { deletedAt: null, readyForPublic: true, tenant: { $in: tenantIds } };
  const chargers = await Charger.find(filter).lean();
  const siteIds = [...new Set(chargers.map((c) => String(c.site)))];
  let sites = await Site.find({ _id: { $in: siteIds }, status: 'active' }).lean();
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    sites = sites.filter((s) => rx.test(s.name) || rx.test(s.city || '') || rx.test(s.address || ''));
  }
  const siteMap = new Map(sites.map((s) => [String(s._id), s]));
  const tenants = new Map((await Tenant.find({ _id: { $in: tenantIds } }).select('name slug pricesIncludeGst').lean()).map((t) => [String(t._id), t]));
  const origin = lat && lng ? { lat: Number(lat), lng: Number(lng) } : null;
  let out = [];
  for (const ch of chargers) {
    const site = siteMap.get(String(ch.site));
    if (!site) continue;
    const pc = await publicCharger(ch, { site, tenant: tenants.get(String(ch.tenant)), origin });
    if (connector && !pc.connectors.some((c) => c.type === connector)) continue;
    if (powerType && !pc.connectors.some((c) => c.powerType === powerType)) continue;
    if (vehicle && !pc.connectors.some((c) => (c.vehicleTypes || []).includes(vehicle))) continue;
    pc.availableNow = pc.connectors.some((c) => c.status === 'Available');
    if (onlyAvailable && !pc.working) continue; // DIS-04: not working chargers hidden by default
    out.push(pc);
  }
  if (origin) out.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  const inRadius = origin ? out.filter((c) => c.distanceKm === null || c.distanceKm <= Number(radiusKm)) : out;
  // DIS-06: nothing nearby -> return the nearest one with a widen-search hint
  if (origin && !inRadius.length && out.length) return res.json({ chargers: [out[0]], nearestOnly: true });
  return res.json({ chargers: inRadius, nearestOnly: false });
});

router.get('/chargers/:ocppId', async (req, res) => {
  const ch = await Charger.findOne({ ocppId: req.params.ocppId, deletedAt: null }).lean();
  const t = ch && (await Tenant.findById(ch.tenant).lean());
  if (!ch || t?.status !== 'active') throw new AppError(404, 'NOT_IN_SERVICE', 'This charger is not in service.');
  res.json(await publicCharger(ch));
});

/** QR landing: charger + connector preselected (QR-01); disabled chargers return alternatives (QR-03). */
router.get('/qr/:ocppId/:connector', async (req, res) => {
  const ch = await Charger.findOne({ ocppId: req.params.ocppId }).lean();
  const t = ch && (await Tenant.findById(ch.tenant).lean());
  const site = ch && (await Site.findById(ch.site).lean());
  const notInService = !ch || ch.deletedAt || t?.status !== 'active' || !ch.inService;
  if (notInService) {
    const alts = [];
    if (site?.location?.lat !== undefined) {
      const near = await Charger.find({ deletedAt: null, readyForPublic: true, _id: { $ne: ch?._id }, online: true, inService: true }).limit(30).lean();
      for (const n of near) {
        const pc = await publicCharger(n, { origin: site.location });
        if (pc.working) alts.push(pc);
      }
      alts.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    }
    return res.status(404).json({ error: { code: 'NOT_IN_SERVICE', message: 'This charger is not in service.' }, alternatives: alts.slice(0, 3) });
  }
  const pc = await publicCharger(ch, { site, tenant: t });
  const conn = pc.connectors.find((c) => c.number === Number(req.params.connector));
  if (!conn) throw new AppError(404, 'NOT_FOUND', 'Connector not found on this charger.');
  const tariff = await activeTariff(ch.tenant, ch.connectors.find((c) => c.number === conn.number)?.tariffKey || ch.tariffKey);
  const amounts = PRESET_AMOUNTS.map((a) => estimateForAmount(tariff, a, conn.maxPowerKw, !!t.pricesIncludeGst));
  return res.json({ ...pc, connector: conn, amounts, printedId: ch.ocppId });
});

router.get('/estimate/:ocppId/:connector', async (req, res) => {
  const ch = await Charger.findOne({ ocppId: req.params.ocppId }).lean();
  if (!ch) throw new AppError(404, 'NOT_FOUND', 'Not found.');
  const c = ch.connectors.find((x) => x.number === Number(req.params.connector));
  const t = await Tenant.findById(ch.tenant).lean();
  const tariff = await activeTariff(ch.tenant, c?.tariffKey || ch.tariffKey);
  res.json(estimateForAmount(tariff, Number(req.query.amountPaise || 20000), c?.maxPowerKw, !!t.pricesIncludeGst));
});

router.get('/content', async (req, res) => {
  const lang = req.query.lang || 'en';
  const items = await Content.find({ active: true, lang: { $in: [lang, 'en'] } }).sort({ kind: 1, order: 1 }).lean();
  res.json({ items });
});

router.get('/branding/:slug', async (req, res) => {
  const t = await Tenant.findOne({ slug: req.params.slug }).select('name slug branding').lean();
  if (!t) throw new AppError(404, 'NOT_FOUND', 'Not found.');
  res.json({ slug: t.slug, name: t.branding?.appName || t.name, logoUrl: t.branding?.logoUrl, primaryColor: t.branding?.primaryColor, accentColor: t.branding?.accentColor });
});

/** Partner network chargers from roaming partners (eMSP / roaming OUT). */
router.get('/partner-locations', async (_req, res) => {
  const locs = await PartnerLocation.find().limit(500).populate('partner', 'name enabled').lean();
  res.json({ locations: locs.filter((l) => l.partner?.enabled).map((l) => ({ id: l._id, partner: l.partner.name, name: l.name, address: l.address, city: l.city, coordinates: l.coordinates, evses: (l.evses || []).map((e) => ({ uid: e.uid, status: e.status, connectors: e.connectors })) })) });
});

/** Route planner: charging stops along a trip (Phase 2). */
router.post('/route-plan', async (req, res) => {
  const pt = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
  const b = parse(z.object({
    from: pt, to: pt,
    rangeKm: z.number().min(20).max(1000),
    socPct: z.number().min(1).max(100).default(80),
    reservePct: z.number().min(0).max(50).default(15),
    chargeToPct: z.number().min(30).max(100).default(80),
    batteryKwh: z.number().min(1).max(250).default(40),
    corridorKm: z.number().min(1).max(30).default(8),
    connectorTypes: z.array(z.string()).optional(),
    vehicleType: z.enum(['2W', '3W', 'car', 'bus']).optional(),
  }), req.body);
  res.json(await planRoute(b));
});

// Guests (no account) exercise data rights by proving the phone number with an OTP.
router.post('/data-requests/otp', async (req, res) => {
  const b = parse(z.object({ phone: phoneSchema }), req.body);
  res.json(await requestOtp(b.phone, 'data_request'));
});

router.post('/data-requests', async (req, res) => {
  const b = parse(z.object({ phone: phoneSchema, code: z.string(), kind: z.enum(['delete', 'export']), reason: z.string().max(500).optional() }), req.body);
  await verifyOtp(b.phone, 'data_request', b.code);
  if (b.kind === 'export') {
    await DataRequest.create({ phone: b.phone, kind: 'export', source: 'guest_request', status: 'completed', completedAt: new Date(), history: [{ status: 'completed', at: new Date(), note: 'guest export after OTP' }] });
    return res.json({ export: await exportData({ phone: b.phone }) });
  }
  const r = await openRequest({ phone: b.phone, kind: 'delete', source: 'guest_request', reason: b.reason });
  return res.status(201).json({ request: { id: r._id, status: r.status, dueAt: r.dueAt } });
});

export default router;
