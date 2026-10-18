// Super-Admin console (our company): tenants, money, platform switches, roaming partners, content.
import express from 'express';
import bcrypt from 'bcryptjs';
import { Adjustment, Alert, Cdr, Charger, ChargerModel, CommissionRule, Content, DataRequest, Invoice, NotificationTemplate, Payment, Payout, ReconciliationRun, Refund, RoamingPartner, SecurityEvent, Session, Settlement, Site, Tariff, Tenant, User } from '../models/index.js';
import { parse, phoneSchema, z } from '../lib/validate.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { escapeRegex, randomToken } from '../lib/util.js';
import { maskPhone } from '../lib/logger.js';
import { PLATFORM_ROLES } from '../lib/permissions.js';
import { can, requireStaff } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { requestApproval, registerExecutor } from '../services/approvals.js';
import { getSettings, updateSettings } from '../services/settings.js';
import { buildPayout, executePayout, reconcile, runPayouts } from '../services/finance.js';
import { registry, stats, messagesPerSecond } from '../ocpp/registry.js';
import { pullPartnerLocations, ocpiFetch } from '../roaming/ocpi/client.js';
import { platformKeys, UEI_SUBSCRIBER_ID } from '../roaming/uei/routes.js';
import { config } from '../config.js';
import { computeBill } from '../services/tariffs.js';
import { anonymiseGuest, anonymiseUser, exportData } from '../services/privacy.js';
import { providerStatus } from '../services/providers.js';
import { cluster } from '../ocpp/cluster.js';

const router = express.Router();
router.use(requireStaff, (req, _res, next) => (req.isPlatform ? next() : next(forbidden('Platform team only.'))));

// ------------------------------------------------------------- tenants

router.get('/tenants', can('tenant.view_all'), async (req, res) => {
  const tenants = await Tenant.find(req.query.type ? { type: req.query.type } : {}).sort({ createdAt: -1 }).lean();
  const counts = await Charger.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: '$tenant', n: { $sum: 1 }, online: { $sum: { $cond: ['$online', 1, 0] } } } }]);
  res.json({ tenants: tenants.map((t) => ({ ...t, chargers: counts.find((c) => String(c._id) === String(t._id)) || { n: 0, online: 0 } })) });
});

router.post('/tenants', can('tenant.manage'), async (req, res) => {
  const b = parse(z.object({
    name: z.string().min(2).max(120), slug: z.string().regex(/^[a-z0-9-]{3,40}$/), type: z.enum(['company', 'host']).default('company'), gstin: z.string().optional(), legalName: z.string().optional(), address: z.string().optional(),
    ocpiPartyId: z.string().regex(/^[A-Z0-9]{3}$/).optional(), payoutDelayDays: z.number().int().min(0).max(30).default(2),
    owner: z.object({ email: z.string().email(), name: z.string(), phone: phoneSchema, password: z.string().min(8) }),
    commission: z.object({ kind: z.enum(['percent', 'per_kwh', 'fixed']), value: z.number().int().min(0) }).optional(),
    energyPaisePerKwh: z.number().int().min(0).default(1800),
  }), req.body);
  if (await Tenant.exists({ slug: b.slug })) throw conflict('SLUG_TAKEN', 'This slug is taken.');
  const t = await Tenant.create({ name: b.name, slug: b.slug, type: b.type, gstin: b.gstin, legalName: b.legalName, address: b.address, ocpiPartyId: b.ocpiPartyId, payoutDelayDays: b.payoutDelayDays, status: 'pending_kyc', invoicePrefix: b.slug.slice(0, 4).toUpperCase(), contact: { name: b.owner.name, email: b.owner.email, phone: b.owner.phone } });
  let u = await User.findOne({ $or: [{ email: b.owner.email.toLowerCase() }, { phone: b.owner.phone }] });
  if (!u) u = new User({ email: b.owner.email.toLowerCase(), phone: b.owner.phone, name: b.owner.name, passwordHash: await bcrypt.hash(b.owner.password, 10) });
  u.memberships.push({ tenant: t._id, role: 'tenant_owner' });
  await u.save();
  const s = await getSettings();
  await CommissionRule.create({ tenant: t._id, ...(b.commission || s.defaultCommission), effectiveFrom: new Date(0), createdBy: req.user._id, note: 'onboarding' });
  await Tariff.create({ tenant: t._id, key: 'default', name: 'Standard', version: 1, status: 'published', energyPaisePerKwh: b.energyPaisePerKwh, publishedAt: new Date(), createdBy: req.user._id });
  await audit(req, { action: 'tenant.create', entity: 'Tenant', entityId: t._id, tenant: t._id, after: { name: t.name, slug: t.slug } });
  res.status(201).json({ tenant: t });
});

router.patch('/tenants/:id', can('tenant.manage'), async (req, res) => {
  const b = parse(z.object({
    name: z.string().optional(), plan: z.object({ name: z.string(), monthlyFeePerChargerPaise: z.number().int().min(0) }).partial().optional(), payoutDelayDays: z.number().int().min(0).max(30).optional(),
    kyc: z.object({ pan: z.string(), gstin: z.string(), status: z.enum(['pending', 'verified', 'rejected']), notes: z.string() }).partial().optional(),
    featureFlags: z.record(z.boolean()).optional(), ocpiPartyId: z.string().regex(/^[A-Z0-9]{3}$/).optional(),
  }), req.body);
  const t = await Tenant.findById(req.params.id);
  if (!t) throw notFound();
  const before = { plan: t.plan, kyc: t.kyc, featureFlags: Object.fromEntries(t.featureFlags || []), payoutDelayDays: t.payoutDelayDays };
  if (b.name) t.name = b.name;
  if (b.plan) t.plan = { ...(t.plan?.toObject?.() || {}), ...b.plan };
  if (b.kyc) t.kyc = { ...(t.kyc?.toObject?.() || {}), ...b.kyc };
  if (b.payoutDelayDays !== undefined) t.payoutDelayDays = b.payoutDelayDays;
  if (b.ocpiPartyId) t.ocpiPartyId = b.ocpiPartyId;
  if (b.featureFlags) for (const [k, v] of Object.entries(b.featureFlags)) t.featureFlags.set(k, v);
  if (t.kyc?.status === 'verified' && t.status === 'pending_kyc') t.status = 'active';
  await t.save();
  await audit(req, { action: 'tenant.update', entity: 'Tenant', entityId: t._id, tenant: t._id, before, after: b });
  res.json({ tenant: t });
});

/** Suspend: chargers are hidden, data kept (Admin 3.7). */
router.post('/tenants/:id/status', can('platform.switches'), async (req, res) => {
  const b = parse(z.object({ status: z.enum(['active', 'suspended']), reason: z.string().min(3) }), req.body);
  const t = await Tenant.findById(req.params.id);
  if (!t) throw notFound();
  const before = t.status;
  t.status = b.status;
  t.suspendedReason = b.status === 'suspended' ? b.reason : undefined;
  await t.save();
  await audit(req, { action: `tenant.${b.status === 'suspended' ? 'suspend' : 'activate'}`, entity: 'Tenant', entityId: t._id, tenant: t._id, before: { status: before }, after: { status: t.status }, reason: b.reason });
  res.json({ tenant: t });
});

// ------------------------------------------------------------- commission (maker-checker)

router.get('/commission', can('commission.manage', 'tenant.view_all'), async (req, res) => {
  res.json({ rules: await CommissionRule.find(req.query.tenant ? { tenant: req.query.tenant } : {}).sort({ effectiveFrom: -1 }).populate('tenant', 'name').lean() });
});

router.post('/commission', can('commission.manage'), async (req, res) => {
  const b = parse(z.object({ tenant: z.string(), kind: z.enum(['percent', 'per_kwh', 'fixed']), value: z.number().int().min(0), effectiveFrom: z.coerce.date(), reason: z.string().min(3) }), req.body);
  const a = await requestApproval(req, { type: 'commission', tenant: b.tenant, payload: b, summary: `Commission ${b.kind} ${b.value} from ${b.effectiveFrom.toISOString().slice(0, 10)}`, reason: b.reason });
  res.status(202).json({ status: 'PendingApproval', approvalId: a._id });
});

registerExecutor('commission', async (a) => {
  const r = await CommissionRule.create({ tenant: a.payload.tenant, kind: a.payload.kind, value: a.payload.value, effectiveFrom: new Date(a.payload.effectiveFrom), createdBy: a.requestedBy, note: a.reason });
  return { ruleId: r._id };
});

// ------------------------------------------------------------- platform switches (Admin 3.7)

router.get('/settings', can('platform.settings', 'platform.switches'), async (_req, res) => {
  const s = (await getSettings({ fresh: true })).toObject();
  delete s.ueiKeys;
  res.json({ settings: s });
});

router.patch('/settings', can('platform.switches'), async (req, res) => {
  const b = parse(z.object({
    pauseNewPayments: z.boolean().optional(), pauseReason: z.string().max(200).optional(), gatewayDown: z.boolean().optional(),
    maintenanceBanner: z.object({ active: z.boolean(), message: z.string().max(300) }).partial().optional(),
    minAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(), supportPhone: z.string().optional(), supportEmail: z.string().email().optional(),
    featureFlags: z.record(z.boolean()).optional(), adminSessionTimeoutMin: z.number().int().min(5).max(1440).optional(), adminIpAllowList: z.array(z.string()).optional(),
    defaultCommission: z.object({ kind: z.enum(['percent', 'per_kwh', 'fixed']), value: z.number().int().min(0) }).optional(),
    hostSuggestedPricePaisePerKwh: z.number().int().min(500).max(5000).optional(),
    reason: z.string().min(3),
  }), req.body);
  const { reason, ...patch } = b;
  const before = (await getSettings({ fresh: true })).toObject();
  if (patch.maintenanceBanner) patch.maintenanceBanner = { ...before.maintenanceBanner, ...patch.maintenanceBanner };
  if (patch.featureFlags) patch.featureFlags = { ...Object.fromEntries(before.featureFlags || []), ...patch.featureFlags };
  const s = await updateSettings(patch);
  await audit(req, { action: 'platform.settings', entity: 'PlatformSettings', before: Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])), after: patch, reason });
  res.json({ settings: s });
});

// ------------------------------------------------------------- charger models (disable a model / firmware)

router.get('/models', can('model.manage', 'tenant.view_all'), async (_req, res) => {
  const models = await ChargerModel.find().lean();
  const seen = await Charger.aggregate([{ $match: { deletedAt: null, vendor: { $ne: null } } }, { $group: { _id: { vendor: '$vendor', model: '$model', firmware: '$firmware' }, n: { $sum: 1 } } }]);
  res.json({ models, seen: seen.map((s) => ({ ...s._id, chargers: s.n })) });
});

router.put('/models', can('model.manage'), async (req, res) => {
  const b = parse(z.object({ vendor: z.string(), model: z.string(), blocked: z.boolean().optional(), blockedFirmware: z.array(z.string()).optional(), quirks: z.record(z.any()).optional(), notes: z.string().optional(), reason: z.string().min(3) }), req.body);
  const { reason, ...rest } = b;
  const m = await ChargerModel.findOneAndUpdate({ vendor: b.vendor, model: b.model }, { $set: rest }, { upsert: true, new: true });
  await audit(req, { action: 'model.update', entity: 'ChargerModel', entityId: m._id, after: rest, reason });
  res.json({ model: m });
});

// ------------------------------------------------------------- live operations centre (Admin 3.2)

router.get('/ops', can('platform.health', 'tenant.view_all'), async (req, res) => {
  const f = { deletedAt: null };
  if (req.query.tenant) f.tenant = req.query.tenant;
  if (req.query.model) f.model = req.query.model;
  if (req.query.firmware) f.firmware = req.query.firmware;
  const chargers = await Charger.find(f).populate('site', 'name city location').populate('tenant', 'name').select('-passwordHash -configCache').lean();
  const filtered = req.query.city ? chargers.filter((c) => c.site?.city === req.query.city) : chargers;
  const active = await Session.find({ state: { $in: ['STARTING', 'CHARGING', 'STOPPING', 'INTERRUPTED'] }, ...(req.query.tenant ? { tenant: req.query.tenant } : {}) }).populate('driver', 'name phone').populate('tenant', 'name').lean();
  res.json({
    chargers: filtered.map((c) => ({ id: c._id, ocppId: c.ocppId, label: c.label, tenant: c.tenant?.name, site: c.site?.name, city: c.site?.city, location: c.site?.location, online: c.online, model: c.model, firmware: c.firmware, protocol: c.protocol, statuses: c.connectors.map((x) => x.status), charging: c.connectors.some((x) => x.activeSession) })),
    sessions: active.map((s) => ({ id: s._id, tenant: s.tenant?.name, ocppId: s.ocppId, connector: s.connectorNumber, state: s.state, energyWh: s.energyWh, amountPaise: s.prepaidPaise || s.capPaise, liveCostPaise: computeBill(s, { capPaise: s.capPaise }).totalPaise, startedAt: s.startedAt, driver: s.driver?.name || maskPhone(s.driver?.phone || s.guestPhone), powerW: s.live?.powerW })),
  });
});

router.get('/health', can('platform.health'), async (_req, res) => {
  const hour = new Date(Date.now() - 3600_000);
  const [failedStarts, payments, captured, refundQueue, financeQueue, openAlerts, pendingCdrs] = await Promise.all([
    Session.countDocuments({ state: 'FAILED', updatedAt: { $gte: hour } }),
    Payment.countDocuments({ createdAt: { $gte: hour }, provider: { $not: /autopay/ } }),
    Payment.countDocuments({ createdAt: { $gte: hour }, status: 'captured', provider: { $not: /autopay/ } }),
    Refund.countDocuments({ status: { $in: ['pending', 'failed', 'processing'] } }),
    Refund.countDocuments({ status: 'finance_queue' }),
    Alert.countDocuments({ status: 'open' }),
    Cdr.countDocuments({ direction: 'out', status: { $in: ['pending', 'failed'] } }),
  ]);
  const s = await getSettings();
  res.json({
    gateway: { connections: registry.size(), messagesPerSecond: messagesPerSecond(), messagesIn: stats.messagesIn, messagesOut: stats.messagesOut, uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000) },
    lastHour: { failedStarts, payments, paymentSuccessRatePct: payments ? Math.round((captured / payments) * 1000) / 10 : null },
    queues: { refunds: refundQueue, financeQueue, cdrs: pendingCdrs, openAlerts },
    switches: { pauseNewPayments: s.pauseNewPayments, gatewayDown: s.gatewayDown, maintenance: s.maintenanceBanner?.active },
    process: { memoryMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version },
    providers: providerStatus(),
    cluster: { enabled: cluster().enabled, nodeId: cluster().nodeId, leader: cluster().isLeader() },
    tls: { profile3Listener: !!process.env.OCPP_TLS_PORT, ccp: !!process.env.CCP_URL },
  });
});

/** Global search: phone number, session id, charger id, payment id, invoice number (Admin 3.2). */
router.get('/search', can('tenant.view_all'), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) throw badRequest('QUERY_SHORT', 'Type at least 3 characters.');
  const rx = new RegExp(escapeRegex(q), 'i');
  const isId = /^[a-f0-9]{24}$/i.test(q);
  const digits = q.replace(/\D/g, '');
  const users = digits.length >= 6 ? await User.find({ phone: new RegExp(digits) }).select('name phone status').limit(10).lean() : [];
  const [sessions, chargers, payments, invoices] = await Promise.all([
    Session.find({ $or: [...(isId ? [{ _id: q }] : []), ...(digits.length >= 6 ? [{ guestPhone: new RegExp(digits) }, { driver: { $in: users.map((u) => u._id) } }] : []), { transactionId: q }] }).limit(20).populate('tenant', 'name').select('state ocppId createdAt costs.totalPaise tenant').lean(),
    Charger.find({ $or: [{ ocppId: rx }, { label: rx }, { serial: rx }] }).limit(10).populate('tenant', 'name').select('ocppId label online tenant').lean(),
    Payment.find({ $or: [{ orderId: q }, { gatewayPaymentId: q }] }).limit(10).lean(),
    Invoice.find({ number: rx }).limit(10).select('number kind totalPaise session tenant').lean(),
  ]);
  res.json({ users: users.map((u) => ({ ...u, phone: maskPhone(u.phone) })), sessions, chargers, payments, invoices });
});

// ------------------------------------------------------------- money (Admin 3.5)

router.post('/payouts/run', can('payout.run'), async (req, res) => {
  const b = parse(z.object({ tenant: z.string().optional() }), req.body || {});
  let out;
  if (b.tenant) {
    const p = await buildPayout(b.tenant);
    out = p ? [await executePayout(p)] : [];
  } else out = await runPayouts();
  await audit(req, { action: 'payout.run', entity: 'Payout', after: { count: out.length, tenant: b.tenant } });
  res.json({ payouts: out });
});

router.post('/payouts/:id/hold', can('payout.hold'), async (req, res) => {
  const b = parse(z.object({ hold: z.boolean(), reason: z.string().min(3) }), req.body);
  const p = await Payout.findById(req.params.id);
  if (!p) throw notFound();
  if (p.status === 'paid') throw conflict('ALREADY_PAID', 'This payout is already paid.');
  const a = await requestApproval(req, { type: b.hold ? 'payout_hold' : 'payout_release', tenant: p.tenant, payload: { payoutId: String(p._id) }, amountPaise: p.netPaise, summary: `${b.hold ? 'Hold' : 'Release'} payout Rs ${(p.netPaise / 100).toFixed(2)}`, reason: b.reason });
  res.status(202).json({ status: 'PendingApproval', approvalId: a._id });
});

router.post('/tenants/:id/payout-hold', can('payout.hold'), async (req, res) => {
  const b = parse(z.object({ hold: z.boolean(), reason: z.string().min(3) }), req.body);
  const a = await requestApproval(req, { type: b.hold ? 'payout_hold' : 'payout_release', tenant: req.params.id, payload: { tenantId: req.params.id }, summary: `${b.hold ? 'Hold' : 'Release'} all payouts`, reason: b.reason });
  res.status(202).json({ status: 'PendingApproval', approvalId: a._id });
});

registerExecutor('payout_hold', async (a) => {
  if (a.payload.tenantId) await Tenant.updateOne({ _id: a.payload.tenantId }, { $set: { payoutHold: true } });
  if (a.payload.payoutId) await Payout.updateOne({ _id: a.payload.payoutId, status: { $in: ['draft', 'released'] } }, { $set: { status: 'held', holdReason: a.reason } });
  return { held: true };
});
registerExecutor('payout_release', async (a) => {
  if (a.payload.tenantId) await Tenant.updateOne({ _id: a.payload.tenantId }, { $set: { payoutHold: false } });
  if (a.payload.payoutId) {
    const p = await Payout.findOneAndUpdate({ _id: a.payload.payoutId, status: 'held' }, { $set: { status: 'released' } }, { new: true });
    if (p) await executePayout(p);
  }
  return { released: true };
});

/** Manual credit/debit to a tenant: reason + second approval. */
router.post('/adjustments', can('adjustment.create'), async (req, res) => {
  const b = parse(z.object({ tenant: z.string(), amountPaise: z.number().int().refine((v) => v !== 0), reason: z.string().min(3) }), req.body);
  const adj = await Adjustment.create({ tenant: b.tenant, amountPaise: b.amountPaise, reason: b.reason, createdBy: req.user._id });
  const a = await requestApproval(req, { type: 'adjustment', tenant: b.tenant, payload: { adjustmentId: String(adj._id) }, amountPaise: b.amountPaise, summary: `${b.amountPaise > 0 ? 'Credit' : 'Debit'} Rs ${(Math.abs(b.amountPaise) / 100).toFixed(2)}`, reason: b.reason });
  adj.approval = a._id;
  await adj.save();
  res.status(202).json({ adjustment: adj, approvalId: a._id });
});

registerExecutor('adjustment', async (a) => {
  await Adjustment.updateOne({ _id: a.payload.adjustmentId }, { $set: { status: 'applied' } });
  return { applied: true };
});

router.post('/reconciliation/run', can('reconciliation.view'), async (req, res) => {
  const b = parse(z.object({ date: z.coerce.date().optional() }), req.body || {});
  const run = await reconcile(b.date || new Date());
  res.json({ run });
});

router.get('/reconciliation', can('reconciliation.view'), async (_req, res) => {
  res.json({ runs: await ReconciliationRun.find().sort({ createdAt: -1 }).limit(60).lean() });
});

router.get('/revenue', can('finance.view', 'tenant.view_all'), async (req, res) => {
  const since = new Date(Date.now() - Number(req.query.days || 30) * 86400_000);
  const rows = await Session.aggregate([
    { $match: { state: 'BILLED', endedAt: { $gte: since } } },
    { $group: { _id: '$tenant', sessions: { $sum: 1 }, grossPaise: { $sum: '$costs.totalPaise' }, commissionPaise: { $sum: '$commissionPaise' }, energyWh: { $sum: '$energyWh' } } },
  ]);
  const tenants = await Tenant.find({ _id: { $in: rows.map((r) => r._id) } }).select('name').lean();
  res.json({ rows: rows.map((r) => ({ ...r, tenant: tenants.find((t) => String(t._id) === String(r._id))?.name })) });
});

// ------------------------------------------------------------- roaming partners (OCPI / UEI)

router.get('/roaming/partners', can('roaming.view', 'roaming.manage'), async (_req, res) => {
  const partners = await RoamingPartner.find().sort({ createdAt: -1 }).lean();
  const keys = await platformKeys();
  res.json({
    partners: partners.map(({ tokenB, tokenC, sharedSecret, ...p }) => ({ ...p, hasTokenB: !!tokenB, hasTokenC: !!tokenC })),
    ours: { ocpiVersionsUrl: `${config.publicApiUrl}/ocpi/versions`, ueiSubscriberId: UEI_SUBSCRIBER_ID, ueiUrl: `${config.publicApiUrl}/uei`, ueiPublicKey: keys.publicKey },
  });
});

router.post('/roaming/partners', can('roaming.manage'), async (req, res) => {
  const b = parse(z.object({
    name: z.string().min(2), protocol: z.enum(['ocpi', 'uei']), roles: z.array(z.enum(['EMSP', 'CPO'])).default(['EMSP']), countryCode: z.string().length(2).default('IN'), partyId: z.string().max(3).optional(),
    versionsUrl: z.string().url().optional(), tokenB: z.string().optional(), subscriberId: z.string().optional(), subscriberUrl: z.string().url().optional(), signingPublicKey: z.string().optional(),
    tenantsShared: z.array(z.string()).optional(), tariffMarkupBps: z.number().int().min(0).max(5000).optional(),
  }), req.body);
  const p = await RoamingPartner.create({ ...b, tokenA: b.protocol === 'ocpi' ? randomToken(24) : undefined, status: b.protocol === 'uei' && b.signingPublicKey ? 'registered' : 'pending' });
  await audit(req, { action: 'roaming.partner_create', entity: 'RoamingPartner', entityId: p._id, after: { name: p.name, protocol: p.protocol } });
  // Token A is shown once so the partner can call our credentials endpoint.
  res.status(201).json({ partner: { id: p._id, name: p.name }, tokenA: p.tokenA, ourVersionsUrl: `${config.publicApiUrl}/ocpi/versions` });
});

router.patch('/roaming/partners/:id', can('roaming.manage'), async (req, res) => {
  const b = parse(z.object({ enabled: z.boolean().optional(), tenantsShared: z.array(z.string()).optional(), tariffMarkupBps: z.number().int().optional(), signingPublicKey: z.string().optional(), subscriberUrl: z.string().url().optional(), reason: z.string().min(3) }), req.body);
  const p = await RoamingPartner.findById(req.params.id);
  if (!p) throw notFound();
  const before = { enabled: p.enabled };
  const { reason, ...rest } = b;
  Object.assign(p, rest);
  await p.save();
  await audit(req, { action: 'roaming.partner_update', entity: 'RoamingPartner', entityId: p._id, before, after: rest, reason });
  res.json({ ok: true, enabled: p.enabled });
});

/** We initiate the handshake: we hold their token A and versions URL (OCPI credentials POST). */
router.post('/roaming/partners/:id/register', can('roaming.manage'), async (req, res) => {
  const b = parse(z.object({ theirTokenA: z.string(), versionsUrl: z.string().url() }), req.body);
  const p = await RoamingPartner.findById(req.params.id);
  if (!p) throw notFound();
  p.tokenB = b.theirTokenA;
  p.versionsUrl = b.versionsUrl;
  p.tokenC = randomToken(24);
  const versions = await ocpiFetch(p, b.versionsUrl);
  const v = (versions.data || []).find((x) => x.version === '2.2.1');
  if (!v) throw badRequest('NO_221', 'Partner does not support OCPI 2.2.1.');
  const details = await ocpiFetch(p, v.url);
  const map = {};
  for (const e of details.data?.endpoints || []) if (!map[e.identifier] || e.role === 'RECEIVER') map[e.identifier] = e.url;
  p.endpoints = map;
  const cred = await ocpiFetch(p, map.credentials, { method: 'POST', body: { token: p.tokenC, url: `${config.publicApiUrl}/ocpi/versions`, roles: [{ role: 'CPO', country_code: config.ocpi.countryCode, party_id: config.ocpi.platformPartyId, business_details: { name: 'ChargeX' } }] } });
  p.tokenB = cred.data?.token || p.tokenB;
  p.status = 'registered';
  await p.save();
  await audit(req, { action: 'roaming.register', entity: 'RoamingPartner', entityId: p._id });
  res.json({ status: p.status, endpoints: map });
});

router.post('/roaming/partners/:id/pull-locations', can('roaming.manage'), async (req, res) => {
  const p = await RoamingPartner.findById(req.params.id);
  if (!p) throw notFound();
  res.json({ imported: await pullPartnerLocations(p) });
});

router.get('/roaming/cdrs', can('roaming.view'), async (req, res) => {
  const f = {};
  if (req.query.partner) f.partner = req.query.partner;
  if (req.query.status) f.status = req.query.status;
  res.json({ cdrs: await Cdr.find(f).sort({ createdAt: -1 }).limit(300).populate('partner', 'name').lean() });
});

router.post('/roaming/cdrs/:id/retry', can('roaming.manage'), async (req, res) => {
  await Cdr.updateOne({ _id: req.params.id }, { $set: { nextAttemptAt: new Date(), status: 'failed' } });
  const { pushPendingCdrs } = await import('../roaming/ocpi/client.js');
  await pushPendingCdrs();
  res.json({ cdr: await Cdr.findById(req.params.id).lean() });
});

/** Monthly settlement: our CDR totals vs the partner's. A difference creates a dispute with the session list (ROM-04). */
router.post('/roaming/settlements', can('roaming.manage', 'finance.view'), async (req, res) => {
  const b = parse(z.object({ partner: z.string(), month: z.string().regex(/^\d{4}-\d{2}$/), theirTotalPaise: z.number().int().min(0), theirCdrIds: z.array(z.string()).optional() }), req.body);
  const cdrs = await Cdr.find({ partner: b.partner, direction: 'out', month: b.month }).lean();
  const ours = cdrs.reduce((s, c) => s + (c.totalCostPaise || 0), 0);
  const disputed = b.theirCdrIds ? cdrs.filter((c) => !b.theirCdrIds.includes(c.cdrId)).map((c) => c.cdrId) : ours !== b.theirTotalPaise ? cdrs.map((c) => c.cdrId) : [];
  const s = await Settlement.findOneAndUpdate(
    { partner: b.partner, month: b.month },
    { $set: { ourCdrCount: cdrs.length, ourTotalPaise: ours, theirTotalPaise: b.theirTotalPaise, theirCdrCount: b.theirCdrIds?.length, status: ours === b.theirTotalPaise && !disputed.length ? 'matched' : 'disputed', disputedCdrIds: disputed } },
    { upsert: true, new: true },
  );
  await audit(req, { action: 'roaming.settlement', entity: 'Settlement', entityId: s._id, after: { month: b.month, ours, theirs: b.theirTotalPaise, status: s.status } });
  res.json({ settlement: s, sessions: disputed.length ? await Session.find({ _id: { $in: cdrs.filter((c) => disputed.includes(c.cdrId)).map((c) => c.session) } }).select('energyWh costs.totalPaise startedAt endedAt ocppId').lean() : [] });
});

router.get('/roaming/settlements', can('roaming.view', 'finance.view'), async (_req, res) => {
  res.json({ settlements: await Settlement.find().sort({ month: -1 }).populate('partner', 'name').lean() });
});

// ------------------------------------------------------------- content, templates, security, data requests

router.get('/content', can('content.manage'), async (_req, res) => res.json({ items: await Content.find().sort({ kind: 1, order: 1 }).lean() }));
router.post('/content', can('content.manage'), async (req, res) => {
  const b = parse(z.object({ kind: z.enum(['banner', 'faq', 'terms', 'privacy', 'support']), title: z.string().max(200), body: z.string().max(20000), lang: z.enum(['en', 'hi']).default('en'), active: z.boolean().default(true), order: z.number().int().default(0) }), req.body);
  const c = await Content.create(b);
  await audit(req, { action: 'content.create', entity: 'Content', entityId: c._id, after: { kind: c.kind, title: c.title } });
  res.status(201).json({ item: c });
});
router.patch('/content/:id', can('content.manage'), async (req, res) => {
  const c = await Content.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true });
  if (!c) throw notFound();
  await audit(req, { action: 'content.update', entity: 'Content', entityId: c._id, after: req.body });
  res.json({ item: c });
});
router.delete('/content/:id', can('content.manage'), async (req, res) => {
  await Content.deleteOne({ _id: req.params.id });
  await audit(req, { action: 'content.delete', entity: 'Content', entityId: req.params.id });
  res.json({ ok: true });
});

router.get('/templates', can('content.manage'), async (_req, res) => res.json({ templates: await NotificationTemplate.find().sort({ key: 1, channel: 1, lang: 1 }).lean() }));
router.put('/templates', can('content.manage'), async (req, res) => {
  const b = parse(z.object({ key: z.string(), channel: z.enum(['sms', 'whatsapp', 'push', 'email']), lang: z.enum(['en', 'hi']), body: z.string().min(3).max(1000), dltTemplateId: z.string().optional(), approved: z.boolean().optional() }), req.body);
  const t = await NotificationTemplate.findOneAndUpdate({ key: b.key, channel: b.channel, lang: b.lang }, { $set: b }, { upsert: true, new: true });
  await audit(req, { action: 'template.update', entity: 'NotificationTemplate', entityId: t._id, after: b });
  res.json({ template: t });
});

router.get('/security-events', can('audit.view'), async (req, res) => {
  res.json({ events: await SecurityEvent.find(req.query.type ? { type: req.query.type } : {}).sort({ at: -1 }).limit(300).lean() });
});

router.get('/data-requests', can('tenant.view_all'), async (req, res) => {
  const f = req.query.status ? { status: { $in: String(req.query.status).split(',') } } : {};
  const items = await DataRequest.find(f).sort({ createdAt: -1 }).limit(300).populate('user', 'name phone status').populate('handledBy', 'name').lean();
  res.json({ requests: items.map((r) => ({ ...r, phone: maskPhone(r.phone || r.user?.phone), user: r.user && { _id: r.user._id, name: r.user.name, status: r.user.status }, overdue: ['received', 'in_progress'].includes(r.status) && r.dueAt && r.dueAt < new Date() })) });
});

router.post('/data-requests/:id', can('customer.pii', 'tenant.manage'), async (req, res) => {
  const b = parse(z.object({ status: z.enum(['in_progress', 'rejected']), note: z.string().min(3) }), req.body);
  const r = await DataRequest.findById(req.params.id);
  if (!r) throw notFound();
  if (['completed', 'rejected'].includes(r.status)) throw conflict('CLOSED', 'This request is closed.');
  r.status = b.status;
  r.handledBy = req.user._id;
  r.notes = b.note;
  r.history.push({ status: b.status, at: new Date(), by: req.user._id, note: b.note });
  await r.save();
  await audit(req, { action: `data_request.${b.status}`, entity: 'DataRequest', entityId: r._id, reason: b.note });
  res.json({ request: r });
});

/** Carry out the request: export returns the data; delete anonymises the person everywhere. */
router.post('/data-requests/:id/execute', can('customer.pii', 'tenant.manage'), async (req, res) => {
  const b = parse(z.object({ note: z.string().min(3) }), req.body);
  const r = await DataRequest.findById(req.params.id);
  if (!r) throw notFound();
  if (['completed', 'rejected'].includes(r.status)) throw conflict('CLOSED', 'This request is closed.');
  let result;
  let data;
  if (r.kind === 'export') {
    data = await exportData({ userId: r.user, phone: r.phone });
    result = { sessions: data.sessions.length, invoices: data.invoices.length };
  } else if (r.user) {
    const u = await User.findById(r.user);
    result = u && u.status !== 'deleted' ? await anonymiseUser(u) : { alreadyDeleted: true };
  } else {
    result = await anonymiseGuest(r.phone);
    r.phone = undefined;
  }
  r.status = 'completed';
  r.completedAt = new Date();
  r.handledBy = req.user._id;
  r.result = result;
  r.history.push({ status: 'completed', at: new Date(), by: req.user._id, note: b.note });
  await r.save();
  await audit(req, { action: `data_request.execute_${r.kind}`, entity: 'DataRequest', entityId: r._id, after: result, reason: b.note });
  res.json({ request: r, data });
});

// ------------------------------------------------------------- platform staff

router.get('/staff', can('tenant.manage'), async (_req, res) => {
  res.json({ roles: PLATFORM_ROLES, staff: await User.find({ platformRole: { $ne: null } }).select('name email phone platformRole status lastLoginAt').lean() });
});

router.post('/staff', can('tenant.manage'), async (req, res) => {
  const b = parse(z.object({ email: z.string().email(), name: z.string(), phone: phoneSchema, role: z.enum(PLATFORM_ROLES), password: z.string().min(8) }), req.body);
  let u = await User.findOne({ email: b.email.toLowerCase() });
  if (!u) u = new User({ email: b.email.toLowerCase(), phone: b.phone, name: b.name, passwordHash: await bcrypt.hash(b.password, 10) });
  u.platformRole = b.role;
  u.sessionVersion = (u.sessionVersion || 0) + 1;
  await u.save();
  await audit(req, { action: 'platform.staff_add', entity: 'User', entityId: u._id, after: { email: u.email, role: b.role } });
  res.status(201).json({ id: u._id });
});

export default router;
