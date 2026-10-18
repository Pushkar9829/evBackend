// Public API for tenant systems (Phase 3), authenticated with a scoped API key:
//   Authorization: Bearer cx_<prefix>_<secret>   (or X-Api-Key header)
import express from 'express';
import rateLimit from 'express-rate-limit';
import { ApiKey, Charger, Session, Tariff } from '../models/index.js';
import { isTest } from '../config.js';
import { parse, z } from '../lib/validate.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { safeEqual, sha256 } from '../lib/util.js';
import { loadScoped } from '../middleware/auth.js';
import { audit, securityEvent } from '../services/audit.js';
import { computeBill } from '../services/tariffs.js';
import { createSession, requestStop } from '../services/sessionEngine.js';
import { displayStatus } from './public.js';

const router = express.Router();
router.use(express.json({ limit: '100kb' }));

async function apiKeyAuth(req, _res, next) {
  const h = req.headers.authorization || '';
  const raw = (h.startsWith('Bearer ') ? h.slice(7) : req.headers['x-api-key'] || '').trim();
  const m = /^cx_([A-Za-z0-9]{8})_[A-Za-z0-9_-]{20,}$/.exec(raw);
  if (!m) return next(new AppError(401, 'API_KEY_REQUIRED', 'Send your API key as "Authorization: Bearer cx_...".'));
  const key = await ApiKey.findOne({ prefix: m[1] });
  if (!key || !safeEqual(sha256(raw), key.hash)) {
    await securityEvent('api_key_invalid', { prefix: m[1] }, req.ip);
    return next(new AppError(401, 'API_KEY_INVALID', 'Invalid API key.'));
  }
  if (key.revokedAt) return next(new AppError(401, 'API_KEY_REVOKED', 'This API key was revoked.'));
  if (key.expiresAt && key.expiresAt < new Date()) return next(new AppError(401, 'API_KEY_EXPIRED', 'This API key has expired.'));
  ApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date(), lastUsedIp: req.ip }, $inc: { useCount: 1 } }).catch(() => {});
  req.apiKey = key;
  req.ctx = { tenant: String(key.tenant), role: 'api' };
  req.isPlatform = false;
  req.user = { _id: undefined, name: `api:${key.name}` };
  return next();
}

const need = (scope) => (req, _res, next) => (req.apiKey.scopes.includes(scope) ? next() : next(forbidden(`This key lacks the "${scope}" scope.`)));

router.use(apiKeyAuth);
router.use(rateLimit({ windowMs: 60_000, limit: isTest ? 10_000 : 120, keyGenerator: (req) => req.apiKey.prefix, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many requests for this key (120/min).' } } }));

const chargerOut = (c) => ({
  id: c._id, ocppId: c.ocppId, label: c.label, site: c.site?.name ? { id: c.site._id, name: c.site.name, city: c.site.city } : c.site,
  protocol: c.protocol, online: c.online, inService: c.inService, lastSeen: c.lastSeen, firmware: c.firmware, model: c.model,
  connectors: c.connectors.map((x) => ({ number: x.number, type: x.type, powerType: x.powerType, maxPowerKw: x.maxPowerKw, status: displayStatus(c, x), charging: !!x.activeSession })),
});

const sessionOut = (s) => ({
  id: s._id, ocppId: s.ocppId, connector: s.connectorNumber, channel: s.channel, state: s.state,
  createdAt: s.createdAt, startedAt: s.startedAt, endedAt: s.endedAt, energyWh: s.energyWh,
  prepaidPaise: s.prepaidPaise, costs: ['BILLED'].includes(s.state) ? { taxablePaise: s.costs.taxablePaise, gstPaise: s.costs.gstPaise, totalPaise: s.costs.totalPaise } : undefined,
  liveCostPaise: ['CHARGING', 'STOPPING', 'INTERRUPTED'].includes(s.state) ? computeBill(s, { capPaise: s.capPaise }).totalPaise : undefined,
  refundPaise: s.refundPaise, stopReason: s.stopReason, failureReason: s.failureReason,
});

router.get('/me', (req, res) => res.json({ tenant: req.ctx.tenant, key: { name: req.apiKey.name, prefix: req.apiKey.prefix, scopes: req.apiKey.scopes, expiresAt: req.apiKey.expiresAt } }));

router.get('/chargers', need('chargers:read'), async (req, res) => {
  const chargers = await Charger.find({ tenant: req.ctx.tenant, deletedAt: null }).populate('site', 'name city').lean();
  res.json({ data: chargers.map(chargerOut) });
});

router.get('/chargers/:ocppId', need('chargers:read'), async (req, res) => {
  const c = await Charger.findOne({ tenant: req.ctx.tenant, ocppId: req.params.ocppId, deletedAt: null }).populate('site', 'name city').lean();
  if (!c) throw notFound('Charger not found.');
  res.json({ data: chargerOut(c) });
});

/** Operator session started from the tenant's own system (billed to the tenant, like a CMS remote start). */
router.post('/chargers/:ocppId/connectors/:n/start', need('sessions:write'), async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(3).max(200) }), req.body || {});
  const c = await Charger.findOne({ tenant: req.ctx.tenant, ocppId: req.params.ocppId, deletedAt: null }).lean();
  if (!c) throw notFound('Charger not found.');
  const { session } = await createSession({ ocppId: c.ocppId, connectorNumber: Number(req.params.n), admin: true });
  await audit(req, { action: 'api.remote_start', entity: 'Session', entityId: session._id, tenant: req.ctx.tenant, reason: b.reason, after: { key: req.apiKey.prefix } });
  res.status(201).json({ data: sessionOut(await Session.findById(session._id)) });
});

router.get('/sessions', need('sessions:read'), async (req, res) => {
  const q = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), state: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), after: z.string().optional() }), req.query);
  const f = { tenant: req.ctx.tenant };
  if (q.state) f.state = { $in: q.state.split(',') };
  if (q.from || q.to) f.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.after) f._id = { $lt: q.after }; // cursor pagination, newest first
  const items = await Session.find(f).sort({ _id: -1 }).limit(q.limit).lean();
  res.json({ data: items.map(sessionOut), next: items.length === q.limit ? String(items[items.length - 1]._id) : null });
});

router.get('/sessions/:id', need('sessions:read'), async (req, res) => {
  const s = await loadScoped(Session, req.params.id, req, { lean: true });
  res.json({ data: sessionOut(s) });
});

router.post('/sessions/:id/stop', need('sessions:write'), async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(3).max(200) }), req.body || {});
  const s = await loadScoped(Session, req.params.id, req);
  const r = await requestStop(s, { by: `api:${req.apiKey.prefix}`, reason: `api: ${b.reason}` });
  await audit(req, { action: 'api.remote_stop', entity: 'Session', entityId: s._id, tenant: req.ctx.tenant, reason: b.reason, after: r });
  res.json({ data: r });
});

router.get('/tariffs', need('tariffs:read'), async (req, res) => {
  const t = await Tariff.find({ tenant: req.ctx.tenant, status: { $in: ['published', 'scheduled'] } }).sort({ key: 1, version: -1 }).lean();
  res.json({ data: t.map(({ _id, key, name, version, status, energyPaisePerKwh, sessionFeePaise, timePaisePerMin, idle, tod, activeFrom }) => ({ id: _id, key, name, version, status, energyPaisePerKwh, sessionFeePaise, timePaisePerMin, idle, tod, activeFrom })) });
});

router.get('/finance/summary', need('finance:read'), async (req, res) => {
  const days = Math.min(Number(req.query.days || 30), 366);
  const rows = await Session.aggregate([
    { $match: { tenant: req.apiKey.tenant, state: 'BILLED', endedAt: { $gte: new Date(Date.now() - days * 86400_000) } } },
    { $group: { _id: null, sessions: { $sum: 1 }, energyWh: { $sum: '$energyWh' }, revenuePaise: { $sum: '$costs.totalPaise' }, gstPaise: { $sum: '$costs.gstPaise' }, commissionPaise: { $sum: '$commissionPaise' }, tenantSharePaise: { $sum: '$tenantSharePaise' } } },
  ]);
  res.json({ data: { days, ...(rows[0] || { sessions: 0, energyWh: 0, revenuePaise: 0 }), _id: undefined } });
});

export default router;
