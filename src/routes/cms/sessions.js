// Sessions, refunds, customers, complaints (Admin 3.4).
import express from 'express';
import { Complaint, Invoice, Payment, Refund, Session, User } from '../../models/index.js';
import { parse, z } from '../../lib/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { escapeRegex } from '../../lib/util.js';
import { maskPhone } from '../../lib/logger.js';
import { ROLES, roleHas } from '../../lib/permissions.js';
import { can, loadScoped, scope } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { requestApproval, registerExecutor } from '../../services/approvals.js';
import { createRefund, processRefund } from '../../services/refunds.js';
import { forceClose, requestStop } from '../../services/sessionEngine.js';
import { issueSessionInvoice, reissueWithGstin } from '../../services/invoices.js';
import { computeBill } from '../../services/tariffs.js';
import { notify } from '../../services/notifications.js';
import { sessionView } from '../sessions.js';

const router = express.Router();
const FORCE_CLOSE_APPROVAL_PAISE = 100000; // Rs 1000

const pii = (req) => roleHas(req.ctx.role, 'customer.pii');
const showPhone = (req, p) => (p && pii(req) ? p : maskPhone(p));

router.get('/sessions', can('session.view'), async (req, res) => {
  const f = scope(req);
  if (req.query.state) f.state = { $in: String(req.query.state).split(',') };
  if (req.query.active === 'true') f.state = { $in: ['PAID', 'STARTING', 'CHARGING', 'STOPPING', 'INTERRUPTED'] };
  if (req.query.review === 'true') f.reviewNeeded = true;
  if (req.query.charger) f.charger = req.query.charger;
  if (req.query.channel) f.channel = req.query.channel;
  if (req.query.from || req.query.to) f.createdAt = { ...(req.query.from ? { $gte: new Date(req.query.from) } : {}), ...(req.query.to ? { $lte: new Date(req.query.to) } : {}) };
  if (req.query.phone) {
    const users = await User.find({ phone: new RegExp(escapeRegex(req.query.phone)) }).select('_id').lean();
    f.$or = [{ guestPhone: new RegExp(escapeRegex(req.query.phone)) }, { driver: { $in: users.map((u) => u._id) } }];
  }
  const limit = Math.min(Number(req.query.limit || 50), 500);
  const page = Math.max(Number(req.query.page || 1), 1);
  const [items, total] = await Promise.all([
    Session.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('charger', 'ocppId label').populate('driver', 'name phone').populate('tenant', 'name').lean(),
    Session.countDocuments(f),
  ]);
  res.json({
    total,
    page,
    sessions: items.map((s) => ({
      id: s._id, state: s.state, tenant: s.tenant?.name, charger: s.charger?.label || s.charger?.ocppId, ocppId: s.charger?.ocppId, connector: s.connectorNumber, channel: s.channel,
      driver: s.driver ? s.driver.name || showPhone(req, s.driver.phone) : showPhone(req, s.guestPhone),
      energyWh: s.energyWh, prepaidPaise: s.prepaidPaise, totalPaise: s.costs?.totalPaise, refundPaise: s.refundPaise,
      liveCostPaise: ['CHARGING', 'STOPPING', 'INTERRUPTED'].includes(s.state) ? computeBill(s, { capPaise: s.capPaise }).totalPaise : undefined,
      powerW: s.live?.powerW, flags: s.flags, reviewNeeded: s.reviewNeeded, createdAt: s.createdAt, startedAt: s.startedAt, endedAt: s.endedAt, failureReason: s.failureReason,
    })),
  });
});

router.get('/sessions/:id', can('session.view'), async (req, res) => {
  const s = await loadScoped(Session, req.params.id, req, { populate: [{ path: 'charger', select: 'ocppId label protocol' }, { path: 'driver', select: 'name phone status' }, { path: 'site', select: 'name' }] });
  const [payments, refunds, invoice, complaints] = await Promise.all([
    Payment.find({ session: s._id }).lean(),
    Refund.find({ session: s._id }).populate('initiatedBy', 'name email').lean(),
    s.invoice ? Invoice.findById(s.invoice).lean() : null,
    Complaint.find({ session: s._id }).lean(),
  ]);
  const o = s.toObject();
  delete o.accessTokenHash;
  delete o.viewTokenHash;
  delete o.seqSeen;
  if (o.guestPhone) o.guestPhone = showPhone(req, o.guestPhone);
  if (o.driver?.phone) o.driver.phone = showPhone(req, o.driver.phone);
  res.json({ session: o, bill: computeBill(s, { capPaise: s.capPaise }), payments, refunds, invoice, complaints });
});

/** "View as driver" (read-only): exactly what the driver sees; every use is logged. */
router.get('/sessions/:id/as-driver', can('session.view_as_driver'), async (req, res) => {
  const s = await loadScoped(Session, req.params.id, req);
  await audit(req, { action: 'session.view_as_driver', entity: 'Session', entityId: s._id, tenant: s.tenant });
  res.json(await sessionView(s, 'view'));
});

router.post('/sessions/:id/stop', can('session.remote'), async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(3) }), req.body);
  const s = await loadScoped(Session, req.params.id, req);
  const r = await requestStop(s, { by: `staff:${req.user._id}`, reason: `admin: ${b.reason}` });
  await audit(req, { action: 'session.remote_stop', entity: 'Session', entityId: s._id, tenant: s.tenant, reason: b.reason, after: r });
  res.json(r);
});

async function doRefund(req, s, amountPaise, reason, approvalId) {
  const pay = await Payment.findOne({ session: s._id, status: 'captured', _id: s.payment });
  if (!pay) throw badRequest('NO_PAYMENT', 'There is no captured payment on this session.');
  const refund = await createRefund({ payment: pay, session: s, amountPaise, reasonCode: 'admin', reason, kind: 'admin', by: req.user._id, approval: approvalId });
  if (refund) notify('refund_initiated', { user: s.driver, phone: s.guestPhone, session: s._id, vars: { refund: (amountPaise / 100).toFixed(2) } }).catch(() => {});
  return refund;
}

/** Partial/full refund: cannot exceed the amount paid; reason required; above the role limit -> approval (BIL-06, SEC-08). */
router.post('/sessions/:id/refund', can('session.refund'), async (req, res) => {
  const b = parse(z.object({ amountPaise: z.number().int().positive(), reason: z.string().min(3) }), req.body);
  const s = await loadScoped(Session, req.params.id, req);
  const pay = await Payment.findById(s.payment).lean();
  if (!pay || pay.status !== 'captured') throw badRequest('NO_PAYMENT', 'There is no captured payment on this session.');
  const refundable = (pay.paidPaise ?? pay.amountPaise) - (pay.refundedPaise || 0);
  if (b.amountPaise > refundable) throw badRequest('REFUND_EXCEEDS_PAID', `A refund cannot exceed the amount paid. Refundable now: Rs ${(refundable / 100).toFixed(2)}.`);
  const limit = ROLES[req.ctx.role]?.refundLimitPaise ?? Infinity;
  if (b.amountPaise > limit) {
    const a = await requestApproval(req, { type: 'refund', tenant: s.tenant, payload: { sessionId: String(s._id), amountPaise: b.amountPaise }, amountPaise: b.amountPaise, summary: `Refund Rs ${(b.amountPaise / 100).toFixed(2)} on session ${s._id}`, reason: b.reason });
    return res.status(202).json({ status: 'PendingApproval', approvalId: a._id });
  }
  const refund = await doRefund(req, s, b.amountPaise, b.reason);
  await audit(req, { action: 'session.refund', entity: 'Session', entityId: s._id, tenant: s.tenant, after: { amountPaise: b.amountPaise, refundId: refund?._id }, reason: b.reason });
  return res.json({ status: 'Refunded', refund });
});

registerExecutor('refund', async (a, req) => {
  const s = await Session.findById(a.payload.sessionId);
  const r = await doRefund({ user: { _id: a.requestedBy }, ctx: req.ctx }, s, a.payload.amountPaise, a.reason, a._id);
  return { refundId: r?._id, status: r?.status };
});

router.post('/sessions/:id/force-close', can('session.force_close'), async (req, res) => {
  const b = parse(z.object({ finalWh: z.number().int().nonnegative().optional(), reason: z.string().min(3) }), req.body);
  const s = await loadScoped(Session, req.params.id, req);
  const est = computeBill({ ...s.toObject(), energyWh: b.finalWh !== undefined && s.meter?.startWh !== undefined ? Math.max(0, b.finalWh - s.meter.startWh + (s.meter.segmentBaseWh || 0)) : s.energyWh, costs: { energyExact: 0 } }, { capPaise: s.capPaise });
  if (est.totalPaise > FORCE_CLOSE_APPROVAL_PAISE) {
    const a = await requestApproval(req, { type: 'force_close', tenant: s.tenant, payload: { sessionId: String(s._id), finalWh: b.finalWh }, amountPaise: est.totalPaise, summary: `Force-close session ${s._id}`, reason: b.reason });
    return res.status(202).json({ status: 'PendingApproval', approvalId: a._id });
  }
  const out = await forceClose(s, b);
  await audit(req, { action: 'session.force_close', entity: 'Session', entityId: s._id, tenant: s.tenant, reason: b.reason, after: { finalWh: b.finalWh, totalPaise: out?.costs?.totalPaise } });
  return res.json({ status: 'Closed', session: out });
});

registerExecutor('force_close', async (a) => {
  const s = await Session.findById(a.payload.sessionId);
  const out = await forceClose(s, { finalWh: a.payload.finalWh, reason: a.reason });
  return { totalPaise: out?.costs?.totalPaise };
});

router.post('/sessions/:id/notes', can('session.view'), async (req, res) => {
  const b = parse(z.object({ text: z.string().min(1).max(1000), resolveReview: z.boolean().optional() }), req.body);
  const s = await loadScoped(Session, req.params.id, req);
  s.notes.push({ by: req.user._id, text: b.text, at: new Date() });
  if (b.resolveReview) s.reviewNeeded = false;
  await s.save();
  res.json({ notes: s.notes });
});

router.post('/sessions/:id/resend-invoice', can('invoice.manage', 'session.view'), async (req, res) => {
  const s = await loadScoped(Session, req.params.id, req);
  const inv = await issueSessionInvoice(s._id);
  if (!inv) throw badRequest('NO_INVOICE', 'No invoice for this session.');
  await notify('session_completed', { user: s.driver, phone: s.guestPhone, session: s._id, eventAt: new Date(), vars: { kwh: (s.energyWh / 1000).toFixed(2), total: ((s.costs?.totalPaise || 0) / 100).toFixed(2), refund: ((s.refundPaise || 0) / 100).toFixed(2), link: inv.number } });
  await audit(req, { action: 'invoice.resend', entity: 'Invoice', entityId: inv._id, tenant: s.tenant });
  res.json({ invoice: inv });
});

/** Correct GSTIN: credit note + new invoice, never an edit. */
router.post('/invoices/:id/correct-gstin', can('invoice.manage'), async (req, res) => {
  const b = parse(z.object({ gstin: z.string(), buyerName: z.string().optional(), reason: z.string().min(3) }), req.body);
  const inv = await loadScoped(Invoice, req.params.id, req);
  const out = await reissueWithGstin(inv._id, b.gstin, b.buyerName);
  await audit(req, { action: 'invoice.correct_gstin', entity: 'Invoice', entityId: inv._id, tenant: inv.tenant, before: { gstin: inv.buyer?.gstin }, after: { gstin: b.gstin, creditNote: out.creditNote.number, invoice: out.invoice.number }, reason: b.reason });
  res.json(out);
});

router.get('/invoices', can('finance.view', 'invoice.manage'), async (req, res) => {
  const f = scope(req, { siteField: null });
  if (req.query.kind) f.kind = req.query.kind;
  if (req.query.q) f.number = new RegExp(escapeRegex(req.query.q), 'i');
  res.json({ invoices: await Invoice.find(f).sort({ createdAt: -1 }).limit(200).lean() });
});

router.get('/invoices/:id/pdf', can('finance.view', 'invoice.manage', 'session.view'), async (req, res) => {
  const inv = await loadScoped(Invoice, req.params.id, req);
  const { invoicePdf } = await import('../../services/invoices.js');
  invoicePdf(inv, res);
});

// ------------------------------------------------------------- refunds queue

router.get('/refunds', can('finance.view', 'session.refund'), async (req, res) => {
  const f = scope(req, { siteField: null });
  if (req.query.status) f.status = { $in: String(req.query.status).split(',') };
  const refunds = await Refund.find(f).sort({ createdAt: -1 }).limit(200).lean();
  res.json({ refunds: refunds.map((r) => ({ ...r, ageingHours: Math.round((Date.now() - new Date(r.createdAt).getTime()) / 360000) / 10 })) });
});

router.post('/refunds/:id/retry', can('finance.view', 'session.refund'), async (req, res) => {
  const r = await loadScoped(Refund, req.params.id, req);
  if (!['failed', 'finance_queue'].includes(r.status)) throw badRequest('NOT_FAILED', 'Only failed refunds can be retried.');
  r.status = 'failed';
  r.nextAttemptAt = new Date();
  r.attempts = Math.min(r.attempts, 2);
  await r.save();
  const out = await processRefund(r._id);
  await audit(req, { action: 'refund.retry', entity: 'Refund', entityId: r._id, tenant: r.tenant, after: { status: out?.status } });
  res.json({ refund: out });
});

// ------------------------------------------------------------- customers

router.get('/customers', can('customer.view'), async (req, res) => {
  const match = scope(req);
  const rows = await Session.aggregate([
    { $match: { ...match, state: { $in: ['BILLED', 'CHARGING', 'FAILED'] } } },
    { $group: { _id: { driver: '$driver', phone: '$guestPhone' }, sessions: { $sum: 1 }, energyWh: { $sum: '$energyWh' }, spentPaise: { $sum: '$costs.totalPaise' }, last: { $max: '$createdAt' } } },
    { $sort: { last: -1 } },
    { $limit: 500 },
  ]);
  const users = await User.find({ _id: { $in: rows.map((r) => r._id.driver).filter(Boolean) } }).select('name phone status').lean();
  res.json({
    customers: rows.map((r) => {
      const u = users.find((x) => String(x._id) === String(r._id.driver));
      return { userId: u?._id, name: u?.name || (u ? 'Driver' : 'Guest'), phone: showPhone(req, u?.phone || r._id.phone), status: u?.status || 'guest', sessions: r.sessions, energyWh: r.energyWh, spentPaise: r.spentPaise, lastAt: r.last };
    }),
  });
});

router.get('/customers/:userId', can('customer.view'), async (req, res) => {
  const u = await User.findById(req.params.userId).select('name phone status blockedReason vehicles createdAt rfidCards').lean();
  if (!u) throw notFound();
  const sessions = await Session.find({ ...scope(req), driver: u._id }).sort({ createdAt: -1 }).limit(50).lean();
  if (!req.isPlatform && !sessions.length) throw forbidden(); // tenants see only drivers who charged with them
  const complaints = await Complaint.find({ ...scope(req, { siteField: null }), driver: u._id }).lean();
  u.phone = showPhone(req, u.phone);
  res.json({ customer: u, sessions, complaints });
});

router.post('/customers/:userId/block', can('customer.block'), async (req, res) => {
  const b = parse(z.object({ blocked: z.boolean(), reason: z.string().min(3) }), req.body);
  const u = await User.findById(req.params.userId);
  if (!u) throw notFound();
  if (!req.isPlatform && !(await Session.exists({ tenant: req.ctx.tenant, driver: u._id }))) throw forbidden();
  const before = { status: u.status };
  u.status = b.blocked ? 'blocked' : 'active';
  u.blockedReason = b.blocked ? b.reason : undefined;
  await u.save();
  await audit(req, { action: b.blocked ? 'customer.block' : 'customer.unblock', entity: 'User', entityId: u._id, before, after: { status: u.status }, reason: b.reason });
  res.json({ status: u.status });
});

router.post('/customers/:userId/rfid/:uid/block', can('customer.block'), async (req, res) => {
  const b = parse(z.object({ blocked: z.boolean(), reason: z.string().min(3) }), req.body);
  const u = await User.findById(req.params.userId);
  const card = u?.rfidCards.find((c) => c.uid === req.params.uid);
  if (!card) throw notFound();
  card.blocked = b.blocked;
  await u.save();
  await audit(req, { action: 'customer.rfid_block', entity: 'User', entityId: u._id, after: { uid: card.uid, blocked: b.blocked }, reason: b.reason });
  res.json({ ok: true });
});

// ------------------------------------------------------------- complaints

router.get('/complaints', can('complaint.view'), async (req, res) => {
  const f = scope(req, { siteField: null });
  if (req.query.status) f.status = { $in: String(req.query.status).split(',') };
  const items = await Complaint.find(f).sort({ createdAt: -1 }).limit(300).populate('charger', 'ocppId label').populate('driver', 'name phone').lean();
  res.json({ complaints: items.map((c) => ({ ...c, phone: showPhone(req, c.phone || c.driver?.phone), slaRemainingMin: c.slaDueAt ? Math.round((new Date(c.slaDueAt) - Date.now()) / 60000) : null })) });
});

router.patch('/complaints/:id', can('complaint.manage'), async (req, res) => {
  const b = parse(z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(), note: z.string().max(2000).optional(), resolution: z.string().max(2000).optional() }), req.body);
  const c = await loadScoped(Complaint, req.params.id, req);
  const before = { status: c.status };
  if (b.status) c.status = b.status;
  if (b.note) c.notes.push({ by: req.user._id, text: b.note, at: new Date() });
  if (b.resolution) c.resolution = b.resolution;
  if (['resolved', 'closed'].includes(c.status) && !c.resolvedAt) c.resolvedAt = new Date();
  await c.save();
  await audit(req, { action: 'complaint.update', entity: 'Complaint', entityId: c._id, tenant: c.tenant, before, after: { status: c.status } });
  res.json({ complaint: c });
});

export default router;
