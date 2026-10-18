// Dashboard, tariffs, finance, reports, staff, alerts, approvals, audit, branding, promos, simulator.
import express from 'express';
import bcrypt from 'bcryptjs';
import { Adjustment, Alert, Approval, AuditLog, Cdr, Charger, Complaint, Payout, PromoCode, ReconciliationRun, Refund, RoamingPartner, Session, Settlement, Site, Tariff, Tenant, User } from '../../models/index.js';
import { parse, phoneSchema, z } from '../../lib/validate.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { TENANT_ROLES, ROLES } from '../../lib/permissions.js';
import { can, loadScoped, scope, writeTenant } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { decideApproval } from '../../services/approvals.js';
import { nextTariffVersion, previewTariff } from '../../services/tariffs.js';
import { listSims, simAction, startSim, stopSim, getSim } from '../../services/simulators.js';
import { mockControls } from '../../services/payments/mock.js';

const router = express.Router();

const sinceDays = (d) => new Date(Date.now() - d * 86400_000);
const today = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// ------------------------------------------------------------- dashboard

router.get('/dashboard', async (req, res) => {
  const f = scope(req);
  const chargerF = { ...f, deletedAt: null };
  const [chargers, active, todays, openComplaints, openAlerts, review] = await Promise.all([
    Charger.find(chargerF).select('ocppId label online connectors site inService').populate('site', 'name location').lean(),
    Session.countDocuments({ ...f, state: { $in: ['STARTING', 'CHARGING', 'STOPPING', 'INTERRUPTED'] } }),
    Session.find({ ...f, state: 'BILLED', endedAt: { $gte: today() } }).select('energyWh costs.totalPaise').lean(),
    Complaint.countDocuments({ ...scope(req, { siteField: null }), status: { $in: ['open', 'in_progress'] } }),
    Alert.countDocuments({ ...scope(req, { siteField: null }), status: 'open' }),
    Session.countDocuments({ ...f, reviewNeeded: true }),
  ]);
  const faulted = chargers.filter((c) => c.connectors.some((x) => x.status === 'Faulted')).length;
  res.json({
    chargers: { total: chargers.length, online: chargers.filter((c) => c.online).length, offline: chargers.filter((c) => !c.online).length, faulted },
    activeSessions: active,
    today: { sessions: todays.length, energyWh: todays.reduce((s, x) => s + (x.energyWh || 0), 0), revenuePaise: todays.reduce((s, x) => s + (x.costs?.totalPaise || 0), 0) },
    openComplaints,
    openAlerts,
    reviewQueue: review,
    map: chargers.map((c) => ({ id: c._id, ocppId: c.ocppId, label: c.label, online: c.online, site: c.site?.name, location: c.site?.location, statuses: c.connectors.map((x) => x.status), charging: c.connectors.some((x) => x.activeSession) })),
  });
});

// ------------------------------------------------------------- tariffs (versioned)

router.get('/tariffs', can('tariff.view'), async (req, res) => {
  const tariffs = await Tariff.find(scope(req, { siteField: null })).sort({ key: 1, version: -1 }).populate('tenant', 'name').lean();
  res.json({ tariffs });
});

const tariffSchema = z.object({
  tenant: z.string().optional(),
  key: z.string().regex(/^[a-z0-9_-]{2,40}$/, 'lowercase letters, digits, dash'),
  name: z.string().min(2).max(80),
  energyPaisePerKwh: z.number().int().min(0).max(20000),
  sessionFeePaise: z.number().int().min(0).max(100000).default(0),
  timePaisePerMin: z.number().int().min(0).max(10000).default(0),
  minFeePaise: z.number().int().min(0).default(0),
  idle: z.object({ paisePerMin: z.number().int().min(0), graceMin: z.number().int().min(0).max(240), capPaise: z.number().int().min(0) }).partial().optional(),
  tod: z.array(z.object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(24), energyPaisePerKwh: z.number().int().min(0), label: z.string().optional() })).max(6).optional(),
  memberDiscountBps: z.number().int().min(0).max(5000).optional(),
  fleetDiscountBps: z.number().int().min(0).max(5000).optional(),
  roamingEnergyPaisePerKwh: z.number().int().min(0).optional(),
});

router.post('/tariffs', can('tariff.manage'), async (req, res) => {
  const b = parse(tariffSchema, req.body);
  const tenant = writeTenant(req, b.tenant);
  const version = await nextTariffVersion(tenant, b.key);
  const t = await Tariff.create({ ...b, tenant, version, status: 'draft', createdBy: req.user._id });
  await audit(req, { action: 'tariff.create', entity: 'Tariff', entityId: t._id, tenant, after: t });
  res.status(201).json({ tariff: t, preview: previewTariff(t.toObject()) });
});

router.get('/tariffs/:id/preview', can('tariff.view'), async (req, res) => {
  const t = await loadScoped(Tariff, req.params.id, req, { lean: true });
  res.json({ preview: previewTariff(t) });
});

/** Publish (or schedule) a version. Running sessions keep the version they started with (CHG-11). */
router.post('/tariffs/:id/publish', can('tariff.manage'), async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(3), activeFrom: z.coerce.date().optional() }), req.body);
  const t = await loadScoped(Tariff, req.params.id, req);
  if (t.status !== 'draft') throw conflict('NOT_DRAFT', 'Only drafts can be published. Create a new version instead.');
  t.activeFrom = b.activeFrom && b.activeFrom > new Date() ? b.activeFrom : new Date();
  t.status = t.activeFrom > new Date() ? 'scheduled' : 'published';
  t.publishedAt = new Date();
  t.publishReason = b.reason;
  await t.save();
  await audit(req, { action: 'tariff.publish', entity: 'Tariff', entityId: t._id, tenant: t.tenant, after: { key: t.key, version: t.version, energyPaisePerKwh: t.energyPaisePerKwh, activeFrom: t.activeFrom }, reason: b.reason });
  res.json({ tariff: t });
});

/** New draft version based on an existing one. */
router.post('/tariffs/:id/new-version', can('tariff.manage'), async (req, res) => {
  const base = await loadScoped(Tariff, req.params.id, req, { lean: true });
  const b = parse(tariffSchema.partial(), req.body);
  const version = await nextTariffVersion(base.tenant, base.key);
  const { _id, createdAt, updatedAt, publishedAt, publishReason, ...rest } = base;
  const t = await Tariff.create({ ...rest, ...b, tenant: base.tenant, key: base.key, version, status: 'draft', activeFrom: new Date(), createdBy: req.user._id });
  res.status(201).json({ tariff: t, preview: previewTariff(t.toObject()) });
});

// ------------------------------------------------------------- finance

router.get('/finance/summary', can('finance.view'), async (req, res) => {
  const days = Number(req.query.days || 30);
  const f = { ...scope(req), state: 'BILLED', endedAt: { $gte: sinceDays(days) } };
  const rows = await Session.aggregate([
    { $match: f },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$endedAt', timezone: '+05:30' } }, sessions: { $sum: 1 }, energyWh: { $sum: '$energyWh' }, revenuePaise: { $sum: '$costs.totalPaise' }, gstPaise: { $sum: '$costs.gstPaise' }, taxablePaise: { $sum: '$costs.taxablePaise' }, commissionPaise: { $sum: '$commissionPaise' }, tenantSharePaise: { $sum: '$tenantSharePaise' } } },
    { $sort: { _id: 1 } },
  ]);
  const total = rows.reduce((a, r) => ({ sessions: a.sessions + r.sessions, energyWh: a.energyWh + r.energyWh, revenuePaise: a.revenuePaise + r.revenuePaise, gstPaise: a.gstPaise + r.gstPaise, commissionPaise: a.commissionPaise + r.commissionPaise, tenantSharePaise: a.tenantSharePaise + r.tenantSharePaise }), { sessions: 0, energyWh: 0, revenuePaise: 0, gstPaise: 0, commissionPaise: 0, tenantSharePaise: 0 });
  const refunds = await Refund.aggregate([{ $match: { ...scope(req, { siteField: null }), createdAt: { $gte: sinceDays(days) } } }, { $group: { _id: '$status', n: { $sum: 1 }, amountPaise: { $sum: '$amountPaise' } } }]);
  res.json({ days: rows, total, refunds });
});

router.get('/finance/gst', can('finance.view'), async (req, res) => {
  const rows = await Session.aggregate([
    { $match: { ...scope(req), state: 'BILLED', 'costs.totalPaise': { $gt: 0 } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$endedAt', timezone: '+05:30' } }, taxablePaise: { $sum: '$costs.taxablePaise' }, gstPaise: { $sum: '$costs.gstPaise' }, totalPaise: { $sum: '$costs.totalPaise' }, invoices: { $sum: 1 } } },
    { $sort: { _id: -1 } },
  ]);
  res.json({ months: rows });
});

router.get('/finance/payouts', can('finance.view'), async (req, res) => {
  res.json({ payouts: await Payout.find(scope(req, { siteField: null })).sort({ createdAt: -1 }).limit(100).populate('tenant', 'name').select('-lines').lean() });
});

router.get('/finance/payouts/:id', can('finance.view'), async (req, res) => {
  res.json({ payout: await loadScoped(Payout, req.params.id, req, { lean: true }) });
});

router.get('/finance/adjustments', can('finance.view'), async (req, res) => {
  res.json({ adjustments: await Adjustment.find(scope(req, { siteField: null })).sort({ createdAt: -1 }).limit(100).lean() });
});

router.get('/finance/reconciliation', can('reconciliation.view', 'finance.view'), async (req, res) => {
  const runs = await ReconciliationRun.find().sort({ createdAt: -1 }).limit(30).lean();
  const t = req.isPlatform ? null : String(req.ctx.tenant);
  res.json({ runs: runs.map((r) => ({ ...r, mismatches: t ? r.mismatches.filter((m) => String(m.tenant) === t) : r.mismatches })) });
});

// ------------------------------------------------------------- reports

function csv(res, name, rows) {
  const cols = Object.keys(rows[0] || { empty: '' });
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
}

router.get('/reports/chargers', can('report.view'), async (req, res) => {
  const days = Number(req.query.days || 30);
  const chargers = await Charger.find({ ...scope(req), deletedAt: null }).populate('site', 'name').lean();
  const stats = await Session.aggregate([
    { $match: { ...scope(req), createdAt: { $gte: sinceDays(days) } } },
    { $group: { _id: { charger: '$charger', state: '$state' }, n: { $sum: 1 }, energyWh: { $sum: '$energyWh' }, revenuePaise: { $sum: '$costs.totalPaise' }, chargingMs: { $sum: { $cond: [{ $and: ['$startedAt', '$endedAt'] }, { $subtract: ['$endedAt', '$startedAt'] }, 0] } } } },
  ]);
  const rows = chargers.map((c) => {
    const mine = stats.filter((s) => String(s._id.charger) === String(c._id));
    const billed = mine.find((s) => s._id.state === 'BILLED') || { n: 0, energyWh: 0, revenuePaise: 0, chargingMs: 0 };
    const failed = mine.find((s) => s._id.state === 'FAILED')?.n || 0;
    return {
      ocppId: c.ocppId, site: c.site?.name, model: c.model, firmware: c.firmware, uptimePct: c.uptime?.scorePct ?? 100,
      sessions: billed.n, failedSessions: failed, energyKwh: Math.round(billed.energyWh) / 1000, revenueRs: billed.revenuePaise / 100,
      utilisationPct: Math.round((billed.chargingMs / (days * 86400_000 * Math.max(1, c.connectors.length))) * 1000) / 10,
    };
  });
  if (req.query.format === 'csv') return csv(res, 'charger-report', rows);
  return res.json({ rows });
});

router.get('/reports/failures', can('report.view'), async (req, res) => {
  const rows = await Session.aggregate([
    { $match: { ...scope(req), state: { $in: ['FAILED', 'CANCELLED'] }, createdAt: { $gte: sinceDays(Number(req.query.days || 30)) } } },
    { $group: { _id: '$failureReason', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  const out = rows.map((r) => ({ reason: r._id || 'unknown', count: r.n }));
  if (req.query.format === 'csv') return csv(res, 'failed-sessions', out);
  return res.json({ rows: out });
});

router.get('/reports/sessions.csv', can('report.view'), async (req, res) => {
  const sessions = await Session.find({ ...scope(req), createdAt: { $gte: sinceDays(Number(req.query.days || 30)) } }).populate('charger', 'ocppId').lean();
  csv(res, 'sessions', sessions.map((s) => ({ id: s._id, created: s.createdAt?.toISOString(), charger: s.charger?.ocppId, connector: s.connectorNumber, state: s.state, channel: s.channel, energyKwh: (s.energyWh || 0) / 1000, prepaidRs: (s.prepaidPaise || 0) / 100, totalRs: (s.costs?.totalPaise || 0) / 100, gstRs: (s.costs?.gstPaise || 0) / 100, refundRs: (s.refundPaise || 0) / 100, failure: s.failureReason, flags: (s.flags || []).join('|') })));
});

// ------------------------------------------------------------- staff & roles

router.get('/staff', can('staff.manage'), async (req, res) => {
  const tenant = writeTenant(req, req.query.tenant);
  const users = await User.find({ 'memberships.tenant': tenant }).select('name email phone memberships status lastLoginAt twoFactorEnabled').lean();
  res.json({ roles: TENANT_ROLES.filter((r) => r !== 'individual_host'), staff: users.map((u) => ({ ...u, membership: u.memberships.find((m) => String(m.tenant) === String(tenant)), memberships: undefined })) });
});

router.post('/staff', can('staff.manage'), async (req, res) => {
  const b = parse(z.object({ tenant: z.string().optional(), email: z.string().email(), name: z.string().min(2).max(80), phone: phoneSchema.optional(), role: z.enum(TENANT_ROLES), siteIds: z.array(z.string()).optional(), password: z.string().min(8).max(100) }), req.body);
  const tenant = writeTenant(req, b.tenant);
  if (b.role === 'tenant_owner' && req.ctx.role !== 'tenant_owner' && !req.isPlatform) throw forbidden('Only an owner can add another owner.');
  let u = await User.findOne({ email: b.email.toLowerCase() });
  if (u?.membershipFor(tenant)) throw conflict('ALREADY_MEMBER', 'This person is already on your team.');
  if (!u) {
    if (b.phone && (await User.exists({ phone: b.phone }))) {
      u = await User.findOne({ phone: b.phone });
      u.email = b.email.toLowerCase();
    } else u = new User({ email: b.email.toLowerCase(), phone: b.phone, name: b.name });
  }
  if (!u.passwordHash) u.passwordHash = await bcrypt.hash(b.password, 10);
  u.memberships.push({ tenant, role: b.role, siteIds: b.siteIds || [] });
  await u.save();
  await audit(req, { action: 'staff.add', entity: 'User', entityId: u._id, tenant, after: { email: u.email, role: b.role } });
  res.status(201).json({ user: { id: u._id, email: u.email, role: b.role } });
});

router.patch('/staff/:userId', can('staff.manage'), async (req, res) => {
  const b = parse(z.object({ tenant: z.string().optional(), role: z.enum(TENANT_ROLES).optional(), siteIds: z.array(z.string()).optional(), twoFactorEnabled: z.boolean().optional() }), req.body);
  const tenant = writeTenant(req, b.tenant);
  const u = await User.findById(req.params.userId);
  const m = u?.membershipFor(tenant);
  if (!m) throw notFound('Not on this team.');
  if (String(u._id) === String(req.user._id) && b.role) throw forbidden('You cannot change your own role.');
  const before = { role: m.role, siteIds: m.siteIds };
  if (b.role) m.role = b.role;
  if (b.siteIds) m.siteIds = b.siteIds;
  if (b.twoFactorEnabled !== undefined) {
    if (!b.twoFactorEnabled && ROLES[m.role]?.money) throw forbidden('Two-factor login is mandatory for money roles.');
    u.twoFactorEnabled = b.twoFactorEnabled;
  }
  u.sessionVersion = (u.sessionVersion || 0) + 1; // role change applies immediately
  await u.save();
  await audit(req, { action: 'staff.role_change', entity: 'User', entityId: u._id, tenant, before, after: { role: m.role, siteIds: m.siteIds } });
  res.json({ ok: true });
});

router.delete('/staff/:userId', can('staff.manage'), async (req, res) => {
  const tenant = writeTenant(req, req.query.tenant);
  const u = await User.findById(req.params.userId);
  if (!u?.membershipFor(tenant)) throw notFound();
  if (String(u._id) === String(req.user._id)) throw forbidden('You cannot remove yourself.');
  const role = u.membershipFor(tenant).role;
  u.memberships = u.memberships.filter((m) => String(m.tenant) !== String(tenant));
  u.sessionVersion = (u.sessionVersion || 0) + 1;
  await u.save();
  await audit(req, { action: 'staff.remove', entity: 'User', entityId: u._id, tenant, before: { role } });
  res.json({ ok: true });
});

// ------------------------------------------------------------- alerts, approvals, audit

router.get('/alerts', can('alert.view'), async (req, res) => {
  const f = scope(req, { siteField: null });
  f.status = req.query.status ? { $in: String(req.query.status).split(',') } : { $ne: 'resolved' };
  if (req.query.type) f.type = req.query.type;
  res.json({ alerts: await Alert.find(f).sort({ lastAt: -1 }).limit(300).populate('charger', 'ocppId label').lean() });
});

router.post('/alerts/:id', can('alert.view'), async (req, res) => {
  const b = parse(z.object({ status: z.enum(['acknowledged', 'resolved']) }), req.body);
  const a = await loadScoped(Alert, req.params.id, req).catch(async (e) => {
    const x = await Alert.findById(req.params.id);
    if (x && !x.tenant && req.isPlatform) return x;
    throw e;
  });
  a.status = b.status;
  if (b.status === 'resolved') a.resolvedBy = req.user._id;
  await a.save();
  res.json({ alert: a });
});

router.get('/approvals', async (req, res) => {
  const f = req.isPlatform ? {} : { tenant: req.ctx.tenant, scope: 'tenant' };
  f.status = req.query.status ? { $in: String(req.query.status).split(',') } : 'pending';
  const items = await Approval.find(f).sort({ createdAt: -1 }).limit(200).populate('requestedBy', 'name email').populate('decidedBy', 'name email').populate('tenant', 'name').lean();
  res.json({ approvals: items.map((a) => ({ ...a, canDecide: String(a.requestedBy?._id) !== String(req.user._id) && ROLES[req.ctx.role]?.perms.includes('approval.decide') && (a.scope === 'tenant' || req.isPlatform) })) });
});

router.post('/approvals/:id/decide', can('approval.decide'), async (req, res) => {
  const b = parse(z.object({ approve: z.boolean(), note: z.string().max(500).optional() }), req.body);
  res.json({ approval: await decideApproval(req, req.params.id, b) });
});

router.get('/audit', can('audit.view'), async (req, res) => {
  const f = req.isPlatform ? (req.query.tenant ? { tenant: req.query.tenant } : {}) : { tenant: req.ctx.tenant };
  if (req.query.action) f.action = new RegExp(String(req.query.action).replace(/[^\w.]/g, ''), 'i');
  if (req.query.entityId) f.entityId = req.query.entityId;
  const logs = await AuditLog.find(f).sort({ at: -1 }).limit(Math.min(Number(req.query.limit || 200), 2000)).lean();
  if (req.query.format === 'csv') return csv(res, 'audit-log', logs.map((l) => ({ at: l.at.toISOString(), actor: l.actorName, role: l.actorRole, action: l.action, entity: l.entity, entityId: l.entityId, reason: l.reason, ip: l.ip, before: JSON.stringify(l.before ?? ''), after: JSON.stringify(l.after ?? '') })));
  return res.json({ logs });
});

// ------------------------------------------------------------- company settings & branding

router.get('/company', async (req, res) => {
  const id = writeTenant(req, req.query.tenant);
  const t = await Tenant.findById(id).lean();
  if (!t) throw notFound();
  if (!ROLES[req.ctx.role]?.perms.includes('bank.manage')) delete t.bank;
  res.json({ tenant: t });
});

router.patch('/company', can('branding.manage', 'staff.manage'), async (req, res) => {
  const b = parse(z.object({
    tenant: z.string().optional(),
    branding: z.object({ appName: z.string().max(40), logoUrl: z.string().url().or(z.literal('')), primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i), accentColor: z.string().regex(/^#[0-9a-f]{6}$/i) }).partial().optional(),
    alertContacts: z.object({ emails: z.array(z.string().email()), phones: z.array(z.string()) }).partial().optional(),
    complaintSlaHours: z.number().int().min(1).max(240).optional(),
    pricesIncludeGst: z.boolean().optional(),
    gstin: z.string().optional(),
    legalName: z.string().optional(),
    address: z.string().optional(),
    bank: z.object({ accountName: z.string(), accountNumber: z.string().regex(/^\d{9,18}$/), ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/) }).optional(),
  }), req.body);
  const t = await Tenant.findById(writeTenant(req, b.tenant));
  if (b.bank && !ROLES[req.ctx.role]?.perms.includes('bank.manage')) throw forbidden('Only the owner can change bank details.');
  const before = { branding: t.branding, pricesIncludeGst: t.pricesIncludeGst, bank: t.bank };
  if (b.branding) t.branding = { ...(t.branding?.toObject?.() || {}), ...b.branding };
  if (b.alertContacts) t.alertContacts = { ...(t.alertContacts?.toObject?.() || {}), ...b.alertContacts };
  for (const k of ['complaintSlaHours', 'pricesIncludeGst', 'gstin', 'legalName', 'address']) if (b[k] !== undefined) t[k] = b[k];
  if (b.bank) t.bank = { accountName: b.bank.accountName, accountNumberLast4: b.bank.accountNumber.slice(-4), ifsc: b.bank.ifsc, gatewayAccountId: t.bank?.gatewayAccountId };
  await t.save();
  await audit(req, { action: 'company.update', entity: 'Tenant', entityId: t._id, tenant: t._id, before, after: { branding: t.branding, pricesIncludeGst: t.pricesIncludeGst, bank: t.bank } });
  res.json({ tenant: t });
});

// ------------------------------------------------------------- promo codes (Phase 2)

router.get('/promos', can('tariff.manage'), async (req, res) => {
  res.json({ promos: await PromoCode.find(req.isPlatform ? {} : { tenant: req.ctx.tenant }).sort({ createdAt: -1 }).lean() });
});

router.post('/promos', can('tariff.manage'), async (req, res) => {
  const b = parse(z.object({ tenant: z.string().optional(), code: z.string().regex(/^[A-Z0-9]{4,20}$/i), kind: z.enum(['percent', 'flat']), value: z.number().int().positive(), maxDiscountPaise: z.number().int().positive().optional(), perUserLimit: z.number().int().min(1).max(100).default(1), budgetPaise: z.number().int().positive().optional(), expiresAt: z.coerce.date().optional() }), req.body);
  const p = await PromoCode.create({ ...b, tenant: req.isPlatform ? b.tenant : req.ctx.tenant });
  await audit(req, { action: 'promo.create', entity: 'PromoCode', entityId: p._id, tenant: p.tenant, after: p });
  res.status(201).json({ promo: p });
});

router.patch('/promos/:id', can('tariff.manage'), async (req, res) => {
  const p = await PromoCode.findById(req.params.id);
  if (!p || (!req.isPlatform && String(p.tenant) !== String(req.ctx.tenant))) throw notFound();
  p.active = !!req.body.active;
  await p.save();
  res.json({ promo: p });
});

// ------------------------------------------------------------- roaming (tenant view)

router.get('/roaming', can('roaming.view', 'roaming.manage'), async (req, res) => {
  const f = scope(req, { siteField: null });
  const [chargers, cdrs, partners] = await Promise.all([
    Charger.find({ ...scope(req), deletedAt: null }).select('ocppId label roamingEnabled roamingEnabledAt uptime online').lean(),
    Cdr.find({ ...f, direction: 'out' }).sort({ createdAt: -1 }).limit(100).populate('partner', 'name').lean(),
    RoamingPartner.find({ enabled: true }).select('name protocol status roles partyId').lean(),
  ]);
  const settlements = await Settlement.find().sort({ month: -1 }).limit(24).populate('partner', 'name').lean();
  res.json({ chargers, cdrs, partners, settlements: req.isPlatform ? settlements : [] });
});

// ------------------------------------------------------------- simulator

router.get('/simulator', can('simulator.use'), async (req, res) => {
  const chargers = await Charger.find({ ...scope(req), deletedAt: null }).select('ocppId label protocol online isSimulated connectors').lean();
  const sims = listSims().filter((s) => chargers.some((c) => c.ocppId === s.ocppId));
  res.json({ chargers, sims, mockGateway: mockControls });
});

router.post('/simulator/:chargerId/start', can('simulator.use'), async (req, res) => {
  const c = await loadScoped(Charger, req.params.chargerId, req);
  if (c.online && !c.isSimulated && !req.body?.force) throw badRequest('REAL_CHARGER_ONLINE', 'A real charger is connected with this ID. Use force to take over (this rotates its password).');
  const sim = await startSim(c._id, { meterIntervalSec: Number(req.body?.meterIntervalSec || 5), speed: Number(req.body?.speed || 60) });
  await audit(req, { action: 'simulator.start', entity: 'Charger', entityId: c._id, tenant: c.tenant });
  res.json(sim.state());
});

router.post('/simulator/:chargerId/stop', can('simulator.use'), async (req, res) => {
  const c = await loadScoped(Charger, req.params.chargerId, req);
  await stopSim(c.ocppId);
  res.json({ ok: true });
});

router.get('/simulator/:chargerId', can('simulator.use'), async (req, res) => {
  const c = await loadScoped(Charger, req.params.chargerId, req, { lean: true });
  const sim = getSim(c.ocppId);
  res.json(sim ? sim.state() : { ocppId: c.ocppId, online: false, notRunning: true });
});

router.post('/simulator/:chargerId/action', can('simulator.use'), async (req, res) => {
  const c = await loadScoped(Charger, req.params.chargerId, req, { lean: true });
  const b = parse(z.object({ action: z.string(), args: z.record(z.any()).default({}) }), req.body);
  res.json(await simAction(c.ocppId, b.action, b.args));
});

export default router;
