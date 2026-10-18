import express from 'express';
import { Charger, Complaint, Invoice, Payment, Refund, Session, Tenant } from '../models/index.js';
import { config } from '../config.js';
import { parse, phoneSchema, z } from '../lib/validate.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { sha256, safeEqual } from '../lib/util.js';
import { maskPhone } from '../lib/logger.js';
import { optionalAuth } from '../middleware/auth.js';
import { createSession, FAILURE_MESSAGES, onPaymentResult, requestStop, retryPayment, switchConnector } from '../services/sessionEngine.js';
import { computeBill } from '../services/tariffs.js';
import { provider } from '../services/payments/index.js';
import { requestOtp, verifyOtp } from '../services/otp.js';
import { invoicePdf } from '../services/invoices.js';
import { sendCommand } from '../ocpp/commands.js';
import { getSettings } from '../services/settings.js';
import { events } from '../services/events.js';
import { roleHas } from '../lib/permissions.js';

const router = express.Router();
router.use(optionalAuth);

/** owner = paid from this browser or the logged-in driver; view = SMS link; staff = CMS user. */
function accessOf(req, s) {
  const t = req.headers['x-session-token'] || req.query.t;
  const v = req.headers['x-view-token'] || req.query.v;
  if (req.user && req.auth?.kind === 'driver' && s.driver && String(s.driver) === String(req.user._id)) return 'owner';
  if (t && s.accessTokenHash && safeEqual(sha256(t), s.accessTokenHash)) return 'owner';
  if (req.user && req.auth?.kind === 'staff' && roleHas(req.ctx?.role, 'session.view')) {
    if (req.isPlatform || ['super_admin', 'platform_support', 'platform_finance'].includes(req.ctx.role) || String(req.ctx.tenant) === String(s.tenant)) return 'staff';
  }
  if (v && s.viewTokenHash && safeEqual(sha256(v), s.viewTokenHash)) return 'view';
  return null;
}

async function load(req, min = 'view') {
  const s = await Session.findById(req.params.id).catch(() => null);
  if (!s) throw notFound('Session not found.');
  const access = accessOf(req, s);
  if (!access || (min === 'owner' && access === 'view')) {
    // SEC-04: stopping someone else's session is rejected server-side
    throw forbidden(min === 'owner' && access === 'view' ? 'This link is read-only. Verify with an OTP to stop charging.' : 'You cannot access this session.');
  }
  req.access = access;
  return s;
}

const STEPS = ['Payment received', 'Charger contacted', 'Waiting for car', 'Charging'];

/** Driver-facing view of a session, with the live bill and a plain-language status (UX 1.3/1.4). */
export async function sessionView(s, access) {
  const charger = await Charger.findById(s.charger).select('label ocppId online connectors site').populate('site', 'name address').lean();
  const pay = s.payment ? await Payment.findById(s.payment).lean() : null;
  const refunds = await Refund.find({ session: s._id }).select('amountPaise status createdAt succeededAt reasonCode').lean();
  const live = ['CHARGING', 'STOPPING', 'INTERRUPTED'].includes(s.state) ? computeBill(s, { capPaise: s.capPaise }) : null;
  const settings = await getSettings();
  const conn = charger?.connectors.find((c) => c.number === s.connectorNumber);
  let step = 0;
  if (['PAID'].includes(s.state)) step = 1;
  if (s.state === 'STARTING') step = s.pluggedAt ? 2 : 1;
  if (['CHARGING', 'STOPPING', 'INTERRUPTED', 'COMPLETED', 'BILLED'].includes(s.state)) step = 3;
  // English text for API clients + a key/vars pair the driver app translates (Hindi, more later).
  let message = null;
  let messageKey = null;
  const amt = `Rs ${((s.prepaidPaise || s.capPaise || 0) / 100).toFixed(0)}`;
  const messageVars = { amount: amt, reason: pay?.failureReason || '', kwh: ((s.energyWh || 0) / 1000).toFixed(1) };
  const say = (key, text) => {
    messageKey = key;
    message = text;
  };
  if (s.state === 'CREATED') {
    if (pay?.status === 'failed') say('payment_failed', `Payment failed${pay.failureReason ? `: ${pay.failureReason}` : ''}. Nothing was charged. Please try again or use another method.`);
    else if (pay?.status === 'cancelled') say('payment_cancelled', 'Payment cancelled, nothing charged.');
    else say('payment_pending', 'Waiting for your bank to confirm the payment. Charging starts as soon as it is confirmed. If it is not confirmed in 5 minutes, nothing will be charged.');
  } else if (s.state === 'STARTING') {
    if (s.pluggedAt) say('talking', 'Talking to charger... waiting for your car.');
    else say('plug_in', 'Plug the cable into your vehicle.');
  } else if (s.state === 'INTERRUPTED') say('interrupted', `We lost contact with the charger, but charging continues. Your bill will update when it reconnects. You will never pay more than ${amt}.`);
  else if (s.state === 'CHARGING' && s.live?.chargingState === 'SuspendedEV' && !(s.energyWh > 0)) say('ev_not_accepting', 'Your car is not accepting charge.');
  else if (s.state === 'CHARGING' && s.live?.updatedAt && Date.now() - new Date(s.live.updatedAt).getTime() > 10 * 60_000) say('waiting_update', 'Waiting for update from the charger.');
  else if (s.state === 'FAILED') {
    say(`failed_${s.failureReason || 'unknown'}`, `${FAILURE_MESSAGES[s.failureReason] || "Charging didn't start."} ${s.prepaidPaise ? `Your ${amt} is being refunded now (usually instant, up to 5 days for some banks).` : ''}`.trim());
    messageVars.refunding = s.prepaidPaise ? 'yes' : '';
  } else if (s.state === 'CANCELLED') {
    if (s.failureReason === 'payment_timeout') say('cancelled_timeout', 'The payment was not confirmed in 5 minutes, so nothing was charged. If money left your account it will be refunded automatically.');
    else say('cancelled', 'Cancelled. Nothing was charged.');
  } else if (s.state === 'BILLED' && s.stopReason === 'limit') say('limit_used', `Your ${amt} has been used: ${messageVars.kwh} kWh added. Please unplug your vehicle.`);
  else if (s.state === 'BILLED') say('complete', 'Charging complete. Please unplug and free the spot.');
  const inv = s.invoice ? await Invoice.findById(s.invoice).select('number status totalPaise').lean() : null;
  return {
    id: s._id,
    state: s.state,
    access,
    message,
    messageKey,
    messageVars,
    steps: STEPS,
    step,
    channel: s.channel,
    charger: charger && { ocppId: charger.ocppId, label: charger.label || charger.ocppId, online: charger.online, site: charger.site, connectorStatus: conn?.status },
    connectorNumber: s.connectorNumber,
    phone: s.guestPhone ? maskPhone(s.guestPhone) : undefined,
    prepaidPaise: s.prepaidPaise,
    capPaise: s.capPaise,
    postpaid: s.postpaid,
    tariff: s.tariff && { energyPaisePerKwh: s.tariff.lockedEnergyPaisePerKwh || s.tariff.energyPaisePerKwh, band: s.tariff.lockedBand, sessionFeePaise: s.tariff.sessionFeePaise, timePaisePerMin: s.tariff.timePaisePerMin, version: s.tariff.version, idle: s.tariff.idle },
    energyWh: s.energyWh,
    live: s.live,
    liveCostPaise: live?.totalPaise,
    costs: ['BILLED', 'COMPLETED'].includes(s.state) ? s.costs : undefined,
    refundPaise: s.refundPaise,
    refunds,
    payment: pay && { status: pay.status, orderId: pay.orderId, amountPaise: pay.amountPaise, method: pay.method, failureReason: pay.failureReason },
    invoice: inv,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    createdAt: s.createdAt,
    pluggedAt: s.pluggedAt,
    plugDeadline: s.plugDeadline,
    suggestSwitchTo: s.suggestSwitchTo,
    failureReason: s.failureReason,
    stopReason: s.stopReason,
    flags: access === 'staff' ? s.flags : undefined,
    rating: s.rating,
    supportPhone: settings.supportPhone,
  };
}

router.post('/', async (req, res) => {
  const b = parse(z.object({
    ocppId: z.string().min(1),
    connector: z.coerce.number().int().positive(),
    amountPaise: z.coerce.number().int().optional(),
    phone: phoneSchema.optional(),
    promoCode: z.string().max(30).optional(),
    idempotencyKey: z.string().min(8).max(80).optional(),
    fleet: z.boolean().optional(),
  }), req.body);
  const user = req.auth?.kind === 'driver' ? req.user : null;
  const r = await createSession({ ocppId: b.ocppId, connectorNumber: b.connector, amountPaise: b.amountPaise, phone: b.phone, user, channel: user ? 'app' : 'qr', idempotencyKey: b.idempotencyKey, promoCode: b.promoCode, fleetMode: !!b.fleet });
  res.status(r.duplicate ? 200 : 201).json({
    sessionId: r.session._id,
    accessToken: r.accessToken,
    viewToken: r.viewToken,
    duplicate: !!r.duplicate,
    checkout: r.checkout,
    orderId: r.payment?.orderId,
    amountPaise: r.payment?.amountPaise,
    session: await sessionView(r.session, 'owner'),
  });
});

router.get('/:id', async (req, res) => {
  const s = await load(req);
  res.json(await sessionView(s, req.access));
});

/** Live updates by Server-Sent Events. EventSource cannot set headers, so tokens come as query params. */
router.get('/:id/events', async (req, res) => {
  const s = await load(req);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const send = async (doc) => {
    try {
      res.write(`data: ${JSON.stringify(await sessionView(doc, req.access))}\n\n`);
    } catch {
      /* closed */
    }
  };
  await send(s);
  const onSession = async (doc) => {
    if (String(doc._id) !== String(s._id)) return;
    send(doc.remote ? await Session.findById(s._id) : doc);
  };
  events.on('session', onSession);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    events.off('session', onSession);
    clearInterval(ping);
  });
});

router.post('/:id/pay', async (req, res) => {
  const s = await load(req, 'owner');
  const r = await retryPayment(s);
  res.json({ checkout: r.checkout, orderId: r.payment.orderId });
});

/** Return from the gateway/UPI app: verify server-side with the gateway (same final state as the webhook, PAY-06). */
router.post('/:id/verify-payment', async (req, res) => {
  const s = await load(req, 'owner');
  const pay = await Payment.findById(s.payment);
  if (pay?.status === 'created') {
    const st = await provider().fetchOrder(pay.orderId).catch(() => null);
    if (st && st.status !== 'created') await onPaymentResult({ orderId: pay.orderId, status: st.status, gatewayPaymentId: st.paymentId, paidPaise: st.paidPaise, method: st.method, failureReason: st.failureReason });
  }
  res.json(await sessionView(await Session.findById(s._id), req.access));
});

router.post('/:id/stop', async (req, res) => {
  const s = await load(req, 'owner');
  const r = await requestStop(s, { by: req.auth?.kind === 'staff' ? `staff:${req.user._id}` : 'driver', reason: 'driver' });
  res.json({ ...r, session: await sessionView(await Session.findById(s._id), req.access) });
});

// QR-07: someone with the read-only link can stop only after an OTP to the guest's number.
router.post('/:id/stop-otp/request', async (req, res) => {
  const s = await load(req);
  const phone = s.guestPhone || (s.driver && (await (await import('../models/index.js')).User.findById(s.driver).lean())?.phone);
  if (!phone) throw badRequest('NO_PHONE', 'No phone number on this session.');
  res.json(await requestOtp(phone, `stop:${s._id}`));
});

router.post('/:id/stop-otp/verify', async (req, res) => {
  const s = await load(req);
  const b = parse(z.object({ code: z.string() }), req.body);
  const phone = s.guestPhone || (s.driver && (await (await import('../models/index.js')).User.findById(s.driver).lean())?.phone);
  await verifyOtp(phone, `stop:${s._id}`, b.code);
  const r = await requestStop(s, { by: 'driver_otp', reason: 'driver' });
  res.json({ ...r, session: await sessionView(await Session.findById(s._id), req.access) });
});

router.post('/:id/switch-connector', async (req, res) => {
  const s = await load(req, 'owner');
  const b = parse(z.object({ connector: z.coerce.number().int() }), req.body);
  await switchConnector(s, b.connector);
  res.json(await sessionView(await Session.findById(s._id), req.access));
});

/** Cable stuck: send UnlockConnector; if it fails show the support contact (STP-07). */
router.post('/:id/unlock', async (req, res) => {
  const s = await load(req, 'owner');
  const charger = await Charger.findById(s.charger);
  const c = charger.connector(s.connectorNumber);
  const r = await sendCommand(charger, 'UnlockConnector', { evseId: c.evseId, connectorId: c.connectorId }, { reason: `driver unlock ${s._id}` });
  const settings = await getSettings();
  res.json({ ok: r.status === 'Accepted', message: r.status === 'Accepted' ? 'Connector unlocked. You can remove the cable now.' : `We could not unlock the connector. Please call support at ${settings.supportPhone}.`, supportPhone: settings.supportPhone });
});

router.post('/:id/rating', async (req, res) => {
  const s = await load(req, 'owner');
  const b = parse(z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(500).optional() }), req.body);
  if (s.state !== 'BILLED') throw badRequest('NOT_FINISHED', 'You can rate after the session ends.');
  const first = !s.rating?.stars;
  s.rating = { stars: b.stars, comment: b.comment, at: new Date() };
  await s.save();
  if (first) {
    const ch = await Charger.findById(s.charger);
    const n = (ch.rating?.count || 0) + 1;
    ch.rating = { count: n, avg: Math.round((((ch.rating?.avg || 0) * (n - 1) + b.stars) / n) * 10) / 10 };
    await ch.save();
  }
  res.json({ ok: true });
});

/** "Report a problem": session data attached automatically (UX 1.3). */
router.post('/:id/complaint', async (req, res) => {
  const s = await load(req, 'owner');
  const b = parse(z.object({ category: z.enum(['did_not_start', 'overcharged', 'stopped_early', 'refund_missing', 'spot_blocked', 'charger_damaged', 'app_issue', 'other']), description: z.string().max(2000).optional() }), req.body);
  const tenant = await Tenant.findById(s.tenant).select('complaintSlaHours').lean();
  const c = await Complaint.create({
    tenant: s.tenant, session: s._id, charger: s.charger, driver: s.driver, phone: s.guestPhone, category: b.category, description: b.description,
    slaDueAt: new Date(Date.now() + (tenant?.complaintSlaHours || 24) * 3600_000),
  });
  res.status(201).json({ id: c._id, status: c.status, slaDueAt: c.slaDueAt });
});

router.get('/:id/invoice', async (req, res) => {
  const s = await load(req);
  if (!s.invoice) throw new AppError(404, 'NO_INVOICE', s.state === 'BILLED' ? 'Your invoice is being prepared. You will get it shortly.' : 'No invoice for this session.');
  const inv = await Invoice.findById(s.invoice).lean();
  res.json(inv);
});

router.get('/:id/invoice.pdf', async (req, res) => {
  const s = await load(req);
  const inv = s.invoice && (await Invoice.findById(s.invoice));
  if (!inv || inv.status !== 'issued') throw notFound('Invoice not ready yet.');
  invoicePdf(inv, res);
});

router.post('/:id/cancel', async (req, res) => {
  const s = await load(req, 'owner');
  if (!['CREATED', 'PAID', 'STARTING'].includes(s.state)) throw badRequest('CANNOT_CANCEL', 'Charging has already started. Use Stop instead.');
  const r = await requestStop(s, { by: 'driver', reason: 'cancel' });
  res.json({ ...r, session: await sessionView(await Session.findById(s._id), req.access) });
});

export default router;
