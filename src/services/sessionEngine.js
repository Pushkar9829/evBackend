// The charging engine: one state machine for QR guests, app users, fleets, RFID and roaming.
// CREATED -> PAID -> STARTING -> CHARGING -> STOPPING -> COMPLETED -> BILLED
//                       |            |
//                    FAILED      INTERRUPTED (charger offline; resolves on reconnect)
// Golden rules: never show Charging until the charger confirms; never charge more than prepaid;
// no energy = no money; refunds are automatic.
import crypto from 'node:crypto';
import { Charger, ChargerModel, CommissionRule, Fleet, Payment, Session, Site, Tenant, User, Cdr, ACTIVE_STATES } from '../models/index.js';
import { config } from '../config.js';
import { AppError, badRequest, conflict, notFound, unavailable } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/util.js';
import { rupees, roundPaise, gstOn } from '../lib/money.js';
import { logger } from '../lib/logger.js';
import { provider } from './payments/index.js';
import { getSettings, updateSettings } from './settings.js';
import { activeTariff, computeBill, energyRateAt, snapshot } from './tariffs.js';
import { createRefund, refundRemaining } from './refunds.js';
import { issueSessionInvoice } from './invoices.js';
import { notify } from './notifications.js';
import { raiseAlert, resolveAlerts } from './alerts.js';
import { securityEvent } from './audit.js';
import { events } from './events.js';
import { sendCommand, isOnline } from '../ocpp/commands.js';
import { cluster } from '../ocpp/cluster.js';

const C = () => config.charging;
const sessionLink = (s, token) => `${config.publicWebUrl}/s/${s._id}${token ? `?v=${token}` : ''}`;

export const FAILURE_MESSAGES = {
  charger_rejected: "The charger didn't accept the start request, so charging didn't start.",
  charger_offline: 'We lost contact with the charger before charging started.',
  charger_no_response: "The charger didn't respond, so charging didn't start.",
  not_plugged_in: 'No vehicle was plugged in within 2 minutes.',
  start_timeout: "The charger didn't confirm the start in time.",
  connector_taken: 'Someone else started on this connector a moment before you.',
  connector_faulted: 'The connector reported a fault before charging started.',
  amount_mismatch: 'The amount paid did not match the order.',
  cancelled_by_driver: 'You cancelled before charging started.',
  ev_not_accepting: 'Your car is not accepting charge.',
  payment_timeout: 'Your bank did not confirm the payment within 5 minutes.',
};

async function publish(sessionOrId) {
  const s = sessionOrId?._id ? sessionOrId : await Session.findById(sessionOrId);
  if (s) {
    events.emit('session', s);
    cluster().publishSession(s._id); // SSE clients on other nodes
  }
  return s;
}

async function transition(id, from, to, set = {}, note) {
  const s = await Session.findOneAndUpdate(
    { _id: id, state: { $in: [].concat(from) } },
    { $set: { state: to, ...set }, $push: { history: { state: to, at: new Date(), note } } },
    { new: true },
  );
  if (s) publish(s);
  return s;
}

/** Can this charger take a new session right now? Throws a driver-friendly error if not. */
export async function assertChargerUsable(charger, connector) {
  const settings = await getSettings();
  if (!charger || charger.deletedAt) throw new AppError(404, 'NOT_IN_SERVICE', 'This charger is not in service.');
  const tenant = await Tenant.findById(charger.tenant).select('status').lean();
  if (tenant?.status !== 'active') throw new AppError(404, 'NOT_IN_SERVICE', 'This charger is not in service.');
  if (!charger.inService) throw new AppError(409, 'NOT_IN_SERVICE', 'This charger is in maintenance right now.');
  const model = charger.vendor && charger.model ? await ChargerModel.findOne({ vendor: charger.vendor, model: charger.model }).lean() : null;
  if (model?.blocked || model?.blockedFirmware?.includes(charger.firmware)) throw new AppError(409, 'MODEL_BLOCKED', 'This charger is temporarily unavailable.');
  if (!connector) throw notFound('Connector not found on this charger.');
  if (!charger.online || !isOnline(charger.ocppId)) throw new AppError(409, 'CHARGER_OFFLINE', 'This charger is offline right now. Try another charger nearby.');
  if (['Faulted', 'Unavailable'].includes(connector.status)) throw new AppError(409, 'CONNECTOR_UNAVAILABLE', 'This connector is not working right now. Try another connector.');
  if (connector.activeSession) {
    const other = await Session.findById(connector.activeSession).select('state').lean();
    if (other && ACTIVE_STATES.includes(other.state)) throw new AppError(409, 'CONNECTOR_BUSY', 'This connector is already in use.');
  }
  if (connector.status === 'Reserved' && connector.reservedUntil > new Date()) throw new AppError(409, 'CONNECTOR_RESERVED', 'This connector is reserved.');
  return settings;
}

/**
 * Create a session and its payment order. Server creates the order amount (PAY-08), the same
 * idempotency key returns the same session (PAY-09).
 */
export async function createSession({ ocppId, connectorNumber, amountPaise, phone, user, channel = 'qr', idempotencyKey, promoCode, roaming, uei, fleetMode = false, admin = false }) {
  if (idempotencyKey) {
    const prev = await Payment.findOne({ idempotencyKey }).lean();
    if (prev) {
      const s = await Session.findById(prev.session);
      return { session: s, payment: prev, checkout: prev.checkout, duplicate: true };
    }
  }
  const charger = await Charger.findOne({ ocppId });
  const connector = charger?.connector(connectorNumber);
  const settings = await assertChargerUsable(charger, connector);

  let driver = null;
  if (user) {
    driver = await User.findById(user._id || user);
    if (driver?.status === 'blocked') throw new AppError(403, 'BLOCKED', `Your account is blocked. Please contact support at ${settings.supportPhone}.`);
  }
  if (!driver && !phone && !roaming && !uei && !admin) throw badRequest('PHONE_REQUIRED', 'Enter your phone number for the receipt.');

  // Postpaid paths: fleet credit, UPI Autopay mandate, roaming partner, UEI.
  let postpaid = false;
  let cap;
  let fleet = null;
  if (roaming || uei || admin) {
    postpaid = true;
    cap = amountPaise || (admin ? 500000 : 300000);
    if (admin) channel = 'admin';
  } else if (fleetMode && driver?.fleet) {
    fleet = await Fleet.findById(driver.fleet);
    const fd = fleet?.drivers.find((d) => String(d.user) === String(driver._id) && d.active);
    if (!fleet || fleet.status !== 'active' || !fd) throw new AppError(403, 'FLEET_INACTIVE', 'Your fleet account is not active.');
    const monthKey = new Date().toISOString().slice(0, 7);
    const spent = fd.monthKey === monthKey ? fd.monthSpentPaise : 0;
    const remainingDriver = fd.spendLimitPaise ? fd.spendLimitPaise - spent : Infinity;
    const remainingFleet = fleet.creditLimitPaise - fleet.outstandingPaise;
    cap = Math.min(remainingDriver, remainingFleet, config.payments.maxAmountPaise);
    if (cap < config.payments.minAmountPaise) throw new AppError(409, 'FLEET_LIMIT', 'Your fleet spending limit has been reached.');
    postpaid = true;
    channel = 'fleet';
  } else if (channel === 'app' && driver?.autopay?.status === 'active' && !amountPaise) {
    postpaid = true;
    cap = driver.autopay.maxPaise || 200000;
  } else {
    if (settings.pauseNewPayments || settings.gatewayDown) {
      throw unavailable('PAYMENTS_PAUSED', settings.pauseReason || 'Payments are temporarily paused. Running sessions are not affected.');
    }
    if (!Number.isInteger(amountPaise) || amountPaise < config.payments.minAmountPaise || amountPaise > config.payments.maxAmountPaise) {
      throw badRequest('AMOUNT_OUT_OF_RANGE', `Choose an amount between Rs ${rupees(config.payments.minAmountPaise)} and Rs ${rupees(config.payments.maxAmountPaise)}.`);
    }
  }

  const tenant = await Tenant.findById(charger.tenant).lean();
  const tariff = await activeTariff(charger.tenant, connector.tariffKey || charger.tariffKey);
  if (!tariff) throw new AppError(409, 'NO_TARIFF', 'This charger has no price set yet.');

  let promo;
  if (promoCode) promo = await applyPromo(promoCode, { driver, phone, tenant: tenant._id });

  const accessToken = randomToken(18);
  const viewToken = randomToken(12);
  const session = await Session.create({
    tenant: charger.tenant,
    site: charger.site,
    charger: charger._id,
    ocppId: charger.ocppId,
    connectorNumber: connector.number,
    evseId: connector.evseId,
    connectorId: connector.connectorId,
    driver: driver?._id,
    guestPhone: driver ? undefined : phone,
    channel: uei ? 'uei' : roaming ? 'roaming' : channel,
    accessTokenHash: sha256(accessToken),
    viewTokenHash: sha256(viewToken),
    state: 'CREATED',
    history: [{ state: 'CREATED', at: new Date() }],
    tariff: snapshot(tariff, tenant),
    tariffId: tariff._id,
    idToken: crypto.randomBytes(10).toString('hex').toUpperCase(),
    remoteStartId: crypto.randomInt(1, 2_000_000_000),
    postpaid,
    capPaise: postpaid ? cap : amountPaise,
    prepaidPaise: postpaid ? 0 : amountPaise,
    fleet: fleet?._id,
    promo,
    flags: admin ? ['admin_start'] : [],
    roaming: roaming || undefined,
    pluggedAt: connector.status === 'Occupied' ? new Date() : undefined,
  });

  if (postpaid) {
    const s = await transition(session._id, 'CREATED', 'PAID', { paidAt: new Date() }, 'postpaid');
    await lockAndStart(s);
    return { session: await Session.findById(session._id), accessToken, viewToken };
  }

  let order;
  try {
    order = await provider().createOrder({ amountPaise, receipt: String(session._id), notes: { tenant: String(charger.tenant), ocppId } });
  } catch (e) {
    await Session.updateOne({ _id: session._id }, { $set: { state: 'CANCELLED', failureReason: 'gateway_down' } });
    if (e.gatewayDown) {
      await updateSettings({ gatewayDown: true });
      await raiseAlert({ type: 'gateway_down', severity: 'critical', message: `Payment gateway unavailable: ${e.message}`, dedupeKey: 'gateway_down' });
    }
    throw unavailable('PAYMENT_GATEWAY_DOWN', 'Payments are temporarily unavailable. Please try again in a few minutes.');
  }
  const payment = await Payment.create({
    tenant: charger.tenant,
    session: session._id,
    provider: provider().name,
    orderId: order.orderId,
    idempotencyKey,
    amountPaise,
  });
  session.payment = payment._id;
  await session.save();
  return { session, payment, checkout: order.checkout, accessToken, viewToken };
}

/** New payment attempt for a CREATED session after a failure or cancel (PAY-02/03). */
export async function retryPayment(session) {
  if (session.state !== 'CREATED') throw conflict('SESSION_NOT_PAYABLE', 'This session can no longer be paid.');
  const settings = await getSettings();
  if (settings.pauseNewPayments || settings.gatewayDown) throw unavailable('PAYMENTS_PAUSED', 'Payments are temporarily paused.');
  const order = await provider().createOrder({ amountPaise: session.prepaidPaise, receipt: String(session._id) });
  const payment = await Payment.create({ tenant: session.tenant, session: session._id, provider: provider().name, orderId: order.orderId, amountPaise: session.prepaidPaise });
  session.payment = payment._id;
  await session.save();
  return { payment, checkout: order.checkout };
}

async function applyPromo(code, { driver, phone, tenant }) {
  const { PromoCode } = await import('../models/index.js');
  const p = await PromoCode.findOne({ code: String(code).toUpperCase(), active: true });
  if (!p || (p.expiresAt && p.expiresAt < new Date()) || (p.tenant && String(p.tenant) !== String(tenant))) throw badRequest('PROMO_INVALID', 'This promo code is not valid here.');
  const who = driver ? (u) => String(u.user) === String(driver._id) : (u) => u.phone === phone;
  if (p.uses.filter(who).length >= p.perUserLimit) throw badRequest('PROMO_USED', 'You have already used this promo code.');
  if (p.budgetPaise && p.usedPaise >= p.budgetPaise) throw badRequest('PROMO_EXHAUSTED', 'This offer has ended.');
  return { code: p.code, discountPaise: 0, kind: p.kind, value: p.value, max: p.maxDiscountPaise };
}

/** Payment result from webhook, redirect verification or polling — idempotent and order-independent (PAY-05/06). */
export async function onPaymentResult({ orderId, status, gatewayPaymentId, paidPaise, method, failureReason }) {
  const pay = await Payment.findOne({ orderId });
  if (!pay) {
    await securityEvent('payment_unknown_order', { orderId });
    return { unknown: true };
  }
  if (status === 'paid') {
    const prev = await Payment.findOneAndUpdate(
      { _id: pay._id, status: { $in: ['created', 'failed', 'cancelled', 'expired'] } },
      { $set: { status: 'captured', gatewayPaymentId, paidPaise: paidPaise ?? pay.amountPaise, method, capturedAt: new Date() } },
      { new: false },
    );
    if (!prev) return { duplicate: true };
    const captured = await Payment.findById(pay._id);
    const session = await Session.findById(pay.session);
    if (captured.paidPaise !== captured.amountPaise) {
      // Amount tampered on the client: refund what arrived + flag (PAY-08)
      await securityEvent('payment_amount_mismatch', { orderId, expected: captured.amountPaise, paid: captured.paidPaise, tenant: String(pay.tenant) });
      await Session.updateOne({ _id: session._id }, { $addToSet: { flags: 'amount_mismatch' } });
      await refundRemaining(captured._id, { reasonCode: 'amount_mismatch', reason: 'Paid amount did not match order', kind: 'auto' });
      if (session.state === 'CREATED') await failSession(session, 'amount_mismatch', { refund: false });
      return { mismatch: true };
    }
    if (prev.status === 'expired' || session.state !== 'CREATED' || String(session.payment) !== String(pay._id)) {
      // Money arrived after cancel, or a second payment for the same session: refund instantly (PAY-04/10)
      await refundRemaining(captured._id, { reasonCode: 'late_or_duplicate_payment', reason: 'Payment arrived after the session was closed', kind: 'late_payment' });
      return { refunded: true };
    }
    await onPaid(session, captured);
    return { ok: true };
  }
  if (status === 'failed' || status === 'cancelled') {
    await Payment.updateOne({ _id: pay._id, status: 'created' }, { $set: { status: status === 'failed' ? 'failed' : 'cancelled', failureReason, gatewayPaymentId } });
    publish(pay.session);
    return { ok: true, status };
  }
  return { ignored: true };
}

async function onPaid(session, payment) {
  const s = await transition(session._id, 'CREATED', 'PAID', { paidAt: new Date(), payment: payment._id, prepaidPaise: payment.paidPaise, capPaise: payment.paidPaise });
  if (!s) {
    await refundRemaining(payment._id, { reasonCode: 'late_payment', reason: 'Session no longer payable', kind: 'late_payment' });
    return;
  }
  notify('payment_received', { user: s.driver, phone: s.guestPhone, session: s._id, vars: { amount: rupees(s.prepaidPaise) } }).catch(() => {});
  await lockAndStart(s);
}

/** First confirmed payment wins the connector (PAY-10); the loser is refunded instantly. */
async function lockConnector(s) {
  const charger = await Charger.findById(s.charger);
  const conn = charger.connector(s.connectorNumber);
  let stale = null;
  if (conn?.activeSession && String(conn.activeSession) !== String(s._id)) {
    const other = await Session.findById(conn.activeSession).select('state').lean();
    if (!other || !ACTIVE_STATES.includes(other.state)) stale = conn.activeSession;
  }
  const r = await Charger.updateOne(
    { _id: s.charger, connectors: { $elemMatch: { number: s.connectorNumber, activeSession: { $in: [null, s._id, ...(stale ? [stale] : [])] } } } },
    { $set: { 'connectors.$.activeSession': s._id } },
  );
  return r.matchedCount > 0;
}

export async function releaseConnector(s) {
  await Charger.updateOne({ _id: s.charger, connectors: { $elemMatch: { number: s.connectorNumber, activeSession: s._id } } }, { $set: { 'connectors.$.activeSession': null } });
}

async function lockAndStart(s) {
  if (!(await lockConnector(s))) return failSession(s, 'connector_taken');
  return beginStart(s);
}

export async function beginStart(s) {
  const charger = await Charger.findById(s.charger);
  if (!isOnline(charger.ocppId)) return failSession(s, 'charger_offline');
  const now = Date.now();
  const s2 = await transition(s._id, 'PAID', 'STARTING', {
    startRequestedAt: new Date(now),
    plugDeadline: new Date(now + C().plugInWindowSec * 1000),
    startDeadline: new Date(now + C().startTimeoutSec * 1000),
  });
  if (!s2) return null;
  const conn = charger.connector(s2.connectorNumber);
  const res = await sendCommand(charger, 'RequestStartTransaction', { idToken: { idToken: s2.idToken, type: 'Central' }, remoteStartId: s2.remoteStartId, evseId: conn.evseId }, { reason: `session ${s2._id}`, timeoutMs: 15000 });
  if (res.status === 'Rejected') return failSession(s2, 'charger_rejected');
  if (res.status === 'Offline') return failSession(s2, 'charger_offline');
  if (res.status !== 'Accepted') return failSession(s2, 'charger_no_response');
  return s2;
}

/** Fail before charging: full automatic refund + "try another connector" (STA-03/04/06/07). */
export async function failSession(s, reason, { refund = true } = {}) {
  const s2 = await Session.findOneAndUpdate(
    { _id: s._id, state: { $in: ['CREATED', 'PAID', 'STARTING', 'STOPPING'] }, startedAt: null },
    { $set: { state: 'FAILED', failureReason: reason, endedAt: new Date() }, $push: { history: { state: 'FAILED', at: new Date(), note: reason } } },
    { new: true },
  );
  if (!s2) return null;
  await releaseConnector(s2);
  if (refund && s2.payment) {
    await refundRemaining(s2.payment, { reasonCode: reason, reason: FAILURE_MESSAGES[reason] || reason, kind: 'auto' }).catch((e) => logger.error('auto refund', e));
  }
  if (s2.prepaidPaise) notify('session_failed', { user: s2.driver, phone: s2.guestPhone, session: s2._id, vars: { amount: rupees(s2.prepaidPaise) } }).catch(() => {});
  if (!['cancelled_by_driver', 'payment_timeout'].includes(reason)) {
    await raiseAlert({ tenant: s2.tenant, type: 'failed_session', charger: s2.charger, session: s2._id, message: `Session failed at ${s2.ocppId}#${s2.connectorNumber}: ${reason}`, dedupeKey: `failed:${s2._id}` });
  }
  events.emit('roaming:session', s2);
  publish(s2);
  return s2;
}

// ---------------------------------------------------------------- OCPP events

const ENERGY = 'Energy.Active.Import.Register';

/** Pull energy (Wh), power (W) and SoC out of a 2.0.1 meterValue array, using the latest sample. */
export function readMeter(meterValue = [], quirks = {}) {
  let out = {};
  const sorted = [...meterValue].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  for (const mv of sorted) {
    for (const sv of mv.sampledValue || []) {
      const m = sv.measurand || ENERGY;
      const unit = sv.unitOfMeasure?.unit;
      const mult = sv.unitOfMeasure?.multiplier ? 10 ** sv.unitOfMeasure.multiplier : 1;
      const v = Number(sv.value) * mult;
      if (Number.isNaN(v)) continue;
      if (m === ENERGY && !sv.phase) out.wh = unit === 'kWh' || quirks.sendsWhAsKwh ? Math.round(v * 1000) : Math.round(v);
      else if (m === 'Energy.Active.Export.Register' && !sv.phase) out.exportWh = unit === 'kWh' ? Math.round(v * 1000) : Math.round(v);
      else if (m === 'Power.Active.Import' && !sv.phase) out.powerW = unit === 'kW' ? v * 1000 : v;
      else if (m === 'SoC') out.soc = v;
      out.at = new Date(mv.timestamp);
    }
  }
  return out;
}

/**
 * Apply an energy reading. Rejects backwards/abnormal values (CHG-03), detects register resets after a
 * reboot and computes energy per segment (CHG-04), ignores stale out-of-order readings (CHG-08).
 */
function applyReading(s, wh, at, { maxPowerKw = 350, older = false } = {}) {
  const m = s.meter || {};
  if (m.startWh === undefined || m.startWh === null) {
    s.meter = { startWh: wh, lastWh: wh, lastAt: at, segmentBaseWh: 0, segmentStartWh: wh };
    return 'start';
  }
  if (wh === m.lastWh) {
    s.meter.lastAt = at > m.lastAt ? at : m.lastAt;
    return 'same';
  }
  if (wh < m.lastWh) {
    if (older || (m.lastAt && at < m.lastAt)) return 'stale';
    const looksLikeReset = wh < Math.max(1000, m.lastWh * 0.1);
    if (looksLikeReset) {
      s.meter.segmentBaseWh = (m.segmentBaseWh || 0) + (m.lastWh - m.segmentStartWh);
      s.meter.segmentStartWh = wh;
      s.meter.lastWh = wh;
      s.meter.lastAt = at;
      if (!s.flags.includes('meter_reset')) s.flags.push('meter_reset');
      return 'reset';
    }
    s.rejectedReadings += 1;
    if (!s.flags.includes('meter_rejected')) s.flags.push('meter_rejected');
    s.reviewNeeded = true;
    return 'rejected';
  }
  // Jump check: more energy than the connector could physically deliver since the last reading.
  const hours = Math.max((at - (m.lastAt || at)) / 3600_000, 0.25); // 15-min floor tolerates bursty/queued readings
  const maxWh = maxPowerKw * 1000 * hours * 1.5 + C().overrunToleranceWh;
  const delta = wh - m.lastWh;
  if (delta > maxWh) {
    s.rejectedReadings += 1;
    if (!s.flags.includes('meter_rejected')) s.flags.push('meter_rejected');
    s.reviewNeeded = true;
    return 'rejected';
  }
  const rate = energyRateAt(s.tariff, at, { roaming: s.channel === 'roaming' });
  s.costs.energyExact = (s.costs.energyExact || 0) + (delta * rate) / 1000;
  s.meter.lastWh = wh;
  s.meter.lastAt = at;
  s.meter.lastEnergyAt = new Date();
  return 'ok';
}

const energyOf = (s) => (s.meter?.startWh === undefined || s.meter?.startWh === null ? 0 : (s.meter.segmentBaseWh || 0) + (s.meter.lastWh - s.meter.segmentStartWh));

export async function onTransactionEvent(charger, p) {
  const txId = p.transactionInfo?.transactionId;
  let s = txId ? await Session.findOne({ charger: charger._id, transactionId: txId }) : null;
  if (!s) {
    const q = { charger: charger._id, transactionId: null };
    const rs = p.transactionInfo?.remoteStartId;
    if (rs !== undefined && rs !== null) s = await Session.findOne({ ...q, remoteStartId: rs }).sort({ createdAt: -1 });
    if (!s && p.idToken?.idToken) s = await Session.findOne({ ...q, idToken: p.idToken.idToken }).sort({ createdAt: -1 });
    if (s) s.transactionId = txId;
  }
  if (!s) return onUnknownTransaction(charger, p);

  // Exactly-once processing (CHG-07): seqNo for 2.0.1, timestamp+event for 1.6J.
  const key = Number.isInteger(p.seqNo) ? `s:${p.seqNo}` : `t:${p.eventType}:${p.timestamp}:${JSON.stringify(p.meterValue?.[0]?.sampledValue?.[0]?.value ?? '')}`;
  if (s.seqSeen.includes(key)) return {};
  s.seqSeen.push(key);
  if (s.seqSeen.length > 2000) s.seqSeen = s.seqSeen.slice(-1000);
  const older = Number.isInteger(p.seqNo) && p.seqNo < s.maxSeq;
  if (Number.isInteger(p.seqNo) && p.seqNo > s.maxSeq) s.maxSeq = p.seqNo;

  const serverNow = new Date();
  const chargerTs = new Date(p.timestamp);
  const skew = Math.round((chargerTs - serverNow) / 1000);
  if (Math.abs(skew) > 300) {
    // Charger clock is off: server time is used for billing and ordering; charger time stored (RES-07)
    Charger.updateOne({ _id: charger._id }, { $set: { clockSkewSec: skew } }).catch(() => {});
  }
  const readingAt = Math.abs(skew) > 300 ? serverNow : chargerTs;
  const model = charger.vendor ? await ChargerModel.findOne({ vendor: charger.vendor, model: charger.model }).lean() : null;
  const meter = readMeter(p.meterValue, model?.quirks);
  const conn = charger.connector(s.connectorNumber);

  // Late start: Started arrives after the session already failed/refunded -> stop it, never bill (STA-05)
  if (['FAILED', 'CANCELLED'].includes(s.state)) {
    if (p.eventType !== 'Ended') {
      if (!s.flags.includes('late_start')) {
        s.flags.push('late_start');
        s.reviewNeeded = true;
        await s.save();
        await raiseAlert({ tenant: s.tenant, type: 'late_start', severity: 'warning', charger: s.charger, session: s._id, message: `Late start on ${s.ocppId} after refund; stop sent`, dedupeKey: `late:${s._id}` });
        sendCommand(charger, 'RequestStopTransaction', { transactionId: txId }, { reason: 'late start after refund' }).catch(() => {});
      } else await s.save();
    } else {
      await s.save();
      await releaseConnector(s);
    }
    return {};
  }
  if (['BILLED', 'COMPLETED'].includes(s.state)) {
    await s.save();
    return {};
  }

  if (meter.wh !== undefined) {
    const r = applyReading(s, meter.wh, readingAt, { maxPowerKw: conn?.maxPowerKw || 350, older });
    if (r === 'rejected') logger.warn(`meter reading rejected for session ${s._id}: ${meter.wh} Wh`);
    if (['ok', 'start', 'reset', 'same'].includes(r)) {
      s.meterPoints.push({ t: serverNow, wh: energyOf(s), w: meter.powerW, soc: meter.soc });
      if (s.meterPoints.length > 600) s.meterPoints = s.meterPoints.filter((_, i) => i % 2 === 0); // keep the shape, halve the points
    }
  }
  s.energyWh = energyOf(s);
  // V2G (OCPP 2.1): energy returned to the grid, monotonic like the import register
  if (meter.exportWh !== undefined) {
    s.exportMeter = s.exportMeter?.startWh === undefined || s.exportMeter?.startWh === null ? { startWh: meter.exportWh, lastWh: meter.exportWh } : { startWh: s.exportMeter.startWh, lastWh: Math.max(s.exportMeter.lastWh, meter.exportWh) };
    s.exportedWh = s.exportMeter.lastWh - s.exportMeter.startWh;
  }
  if (meter.powerW !== undefined || meter.soc !== undefined) {
    s.live = s.live || {};
    if (meter.powerW !== undefined) {
      s.live.powerW = meter.powerW;
      if (meter.powerW <= 0 && !s.live.zeroPowerSince) s.live.zeroPowerSince = serverNow;
      if (meter.powerW > 0) s.live.zeroPowerSince = undefined;
    }
    if (meter.soc !== undefined) s.live.socPct = meter.soc;
  }
  if (meter.wh !== undefined || meter.powerW !== undefined) {
    s.live = s.live || {};
    s.live.updatedAt = serverNow;
  }
  const cs = p.transactionInfo?.chargingState;
  if (cs) {
    s.live = s.live || {};
    s.live.chargingState = cs;
    if (['SuspendedEV', 'EVConnected', 'Idle'].includes(cs) && s.energyWh > 0 && !s.chargingEndedAt) s.chargingEndedAt = serverNow;
    if (cs === 'Charging') s.chargingEndedAt = undefined;
  }

  if (p.eventType === 'Started' || (p.eventType === 'Updated' && ['PAID', 'STARTING'].includes(s.state))) {
    if (['PAID', 'STARTING', 'STOPPING'].includes(s.state) && !s.startedAt) {
      s.state = s.state === 'STOPPING' ? 'STOPPING' : 'CHARGING';
      s.startedAt = serverNow;
      s.chargerTime = { ...(s.chargerTime || {}), startedAt: chargerTs };
      s.history.push({ state: 'CHARGING', at: serverNow, note: p.eventType });
      await s.save();
      notify('session_started', { user: s.driver, phone: s.guestPhone, session: s._id, eventAt: chargerTs, vars: { charger: charger.label || charger.ocppId, link: sessionLink(s) } }).catch(() => {});
      events.emit('roaming:session', s);
      publish(s);
      return {};
    }
  }

  if (p.eventType === 'Ended') {
    s.chargerTime = { ...(s.chargerTime || {}), endedAt: chargerTs };
    const chargerReason = p.transactionInfo?.stoppedReason;
    // Keep our own reason (limit, driver, admin...) when the charger just reports our remote stop.
    s.stopReason = s.stopRequestedAt && (!chargerReason || chargerReason === 'Remote') ? s.stopReason || 'Remote' : chargerReason || s.stopReason || 'Local';
    s.endedAt = serverNow;
    if (!s.chargingEndedAt) s.chargingEndedAt = serverNow;
    if (!s.startedAt) s.startedAt = s.startRequestedAt || serverNow;
    s.state = 'COMPLETED';
    s.history.push({ state: 'COMPLETED', at: serverNow, note: s.stopReason });
    await s.save();
    await finalizeSession(s._id);
    return {};
  }

  // Updated while charging (or reconnect from INTERRUPTED)
  if (s.state === 'INTERRUPTED') {
    s.state = 'CHARGING';
    s.history.push({ state: 'CHARGING', at: serverNow, note: 'reconnected' });
    s.interruptedAt = undefined;
  }
  await s.save();
  await checkLimits(s);
  publish(s);
  return {};
}

/** Live checks after a meter update: 80% alert and auto-stop at the prepaid limit (CHG-09). */
async function checkLimits(s) {
  if (!['CHARGING', 'INTERRUPTED'].includes(s.state) || !s.capPaise) return;
  const live = computeBill(s, { capPaise: Infinity });
  if (live.totalPaise >= s.capPaise * 0.8 && !s.alertsSent.includes('amount_80')) {
    await Session.updateOne({ _id: s._id }, { $addToSet: { alertsSent: 'amount_80' } });
    notify('amount_80', { user: s.driver, phone: s.guestPhone, session: s._id, vars: { amount: rupees(s.capPaise) } }).catch(() => {});
  }
  if (live.totalPaise >= s.capPaise) await requestStop(s, { by: 'system', reason: 'limit' });
}

async function onUnknownTransaction(charger, p) {
  // RFID card of a fleet / autopay driver started locally: create a postpaid session on the fly.
  const uid = p.idToken?.idToken;
  if (p.eventType === 'Started' && uid) {
    // Plug & Charge (ISO 15118): the car identified itself with a contract (eMAID) we issued.
    const pncUser = await User.findOne({ vehicles: { $elemMatch: { 'pnc.emaid': uid, 'pnc.revokedAt': null } }, status: 'active' });
    const user = pncUser || (await User.findOne({ 'rfidCards.uid': uid, status: 'active' }));
    const card = pncUser ? { uid } : user?.rfidCards.find((c) => c.uid === uid);
    if (user && card && !card.blocked && (user.fleet || user.autopay?.status === 'active')) {
      const conn = charger.connectorByEvse(p.evse?.id, p.evse?.connectorId) || charger.connectors[0];
      const tenant = await Tenant.findById(charger.tenant).lean();
      const tariff = await activeTariff(charger.tenant, conn.tariffKey || charger.tariffKey);
      const s = await Session.create({
        tenant: charger.tenant, site: charger.site, charger: charger._id, ocppId: charger.ocppId, connectorNumber: conn.number, evseId: conn.evseId, connectorId: conn.connectorId,
        driver: user._id, channel: pncUser ? 'pnc' : 'rfid', state: 'STARTING', history: [{ state: 'STARTING', at: new Date(), note: pncUser ? 'plug & charge' : 'rfid' }], tariff: snapshot(tariff, tenant), tariffId: tariff._id,
        idToken: uid, transactionId: p.transactionInfo.transactionId, postpaid: true, capPaise: user.autopay?.maxPaise || 200000, fleet: user.fleet,
      });
      await lockConnector(s);
      return onTransactionEvent(charger, p);
    }
  }
  if (p.eventType !== 'Ended') {
    await raiseAlert({ tenant: charger.tenant, type: 'unknown_transaction', charger: charger._id, message: `Unknown transaction ${p.transactionInfo?.transactionId} on ${charger.ocppId}`, dedupeKey: `unknowntx:${charger.ocppId}:${p.transactionInfo?.transactionId}` });
  }
  return {};
}

/** Driver/admin/system stop. Safe to call twice (STP-04); queued when the charger is offline (STP-05). */
export async function requestStop(sessionOrId, { by = 'driver', reason = 'driver' } = {}) {
  const s = sessionOrId?._id ? await Session.findById(sessionOrId._id) : await Session.findById(sessionOrId);
  if (!s) throw notFound('Session not found.');
  if (s.state === 'STOPPING') return { alreadyStopping: true, message: 'Already stopping.' };
  if (['CREATED', 'PAID'].includes(s.state) || (s.state === 'STARTING' && !s.transactionId)) {
    if (s.state === 'CREATED') {
      await transition(s._id, 'CREATED', 'CANCELLED', { failureReason: 'cancelled_by_driver' });
      return { cancelled: true };
    }
    const f = await failSession(s, 'cancelled_by_driver');
    return { cancelled: !!f };
  }
  if (!['CHARGING', 'INTERRUPTED', 'STARTING'].includes(s.state)) return { notActive: true, message: 'This session is not running.' };
  const s2 = await transition(s._id, ['CHARGING', 'INTERRUPTED', 'STARTING'], 'STOPPING', { stopRequestedAt: new Date(), stopRequestedBy: by, stopReason: reason }, reason);
  if (!s2) return { alreadyStopping: true, message: 'Already stopping.' };
  return sendStop(s2);
}

async function sendStop(s) {
  const charger = await Charger.findById(s.charger).lean();
  if (!isOnline(charger.ocppId)) {
    await Session.updateOne({ _id: s._id }, { $addToSet: { flags: 'stop_queued' } });
    return { queued: true, message: 'The charger is offline. Please unplug your vehicle; your bill settles when the charger reconnects.' };
  }
  let r = await sendCommand(charger, 'RequestStopTransaction', { transactionId: s.transactionId }, { reason: `stop ${s._id}`, timeoutMs: 15000 });
  if (r.status !== 'Accepted') r = await sendCommand(charger, 'RequestStopTransaction', { transactionId: s.transactionId }, { reason: `stop retry ${s._id}`, timeoutMs: 15000 }); // retry once (STP-02)
  if (r.status !== 'Accepted') {
    await Session.updateOne({ _id: s._id }, { $addToSet: { flags: 'stop_rejected' }, $set: { reviewNeeded: true } });
    await raiseAlert({ tenant: s.tenant, type: 'stop_rejected', severity: 'critical', charger: s.charger, session: s._id, message: `Charger ${s.ocppId} did not accept remote stop (${r.status})`, dedupeKey: `stoprej:${s._id}` });
    return { rejected: true, message: 'The charger did not respond to stop. Please unplug your vehicle to finish. You will never pay more than your prepaid amount.' };
  }
  return { ok: true };
}

/** Bill: final cost capped at prepaid, refund of the unused amount within seconds, invoice, notifications. */
export async function finalizeSession(sessionId, { flag } = {}) {
  const FINALIZABLE = ['COMPLETED', 'INTERRUPTED', 'STOPPING', 'CHARGING'];
  let s = await Session.findOne({ _id: sessionId, state: { $in: FINALIZABLE } });
  if (!s) return null;
  const fromState = s.state;
  if (!s.endedAt) s.endedAt = new Date();
  if (!s.chargingEndedAt) s.chargingEndedAt = s.meter?.lastEnergyAt || s.endedAt;
  s.energyWh = energyOf(s);
  const bill = computeBill(s);
  const flags = [...s.flags];
  if (flag && !flags.includes(flag)) flags.push(flag);
  if (bill.absorbedPaise > 0 && !flags.includes('overrun')) flags.push('overrun');
  const refundPaise = s.postpaid ? 0 : Math.max(0, s.prepaidPaise - bill.totalPaise);

  // Revenue split
  const commission = await commissionFor(s, bill);
  const site = s.site ? await Site.findById(s.site).select('revenueShareBps').lean() : null;
  const siteHostSharePaise = site?.revenueShareBps ? roundPaise((bill.taxablePaise * site.revenueShareBps) / 10000) : 0;
  const { lines, ...costs } = bill;

  // State and final numbers are written together, guarded by the state we read: billed exactly once,
  // and nobody ever sees BILLED without its costs.
  const done = await Session.findOneAndUpdate(
    { _id: s._id, state: fromState },
    {
      $set: {
        state: 'BILLED', endedAt: s.endedAt, chargingEndedAt: s.chargingEndedAt, energyWh: s.energyWh, flags,
        costs: { ...costs, energyExact: s.costs.energyExact }, refundPaise, commissionPaise: commission, siteHostSharePaise,
        tenantSharePaise: bill.totalPaise - commission - gstOn(commission) - siteHostSharePaise,
        ...(flag ? { reviewNeeded: true } : {}),
      },
      $push: { history: { state: 'BILLED', at: new Date(), note: flag } },
    },
    { new: true },
  );
  if (!done) return null;
  s = done;
  await releaseConnector(s);

  if (s.refundPaise > 0 && s.payment) {
    await createRefund({ payment: s.payment, session: s, amountPaise: s.refundPaise, reasonCode: bill.totalPaise === 0 ? 'no_energy' : 'unused_amount', reason: 'Unused prepaid amount', kind: 'auto' }).catch((e) => logger.error('refund unused', e));
  }
  if (s.energyWh > 0) await Charger.updateOne({ _id: s.charger }, { $set: { lastSuccessfulChargeAt: s.endedAt } });
  if (s.driver) await User.updateOne({ _id: s.driver }, { $set: { lastChargerId: s.charger, ...(s.prepaidPaise ? { lastAmountPaise: s.prepaidPaise } : {}) } });
  if (s.promo?.code && bill.discountPaise > 0) {
    const { PromoCode } = await import('../models/index.js');
    await PromoCode.updateOne({ code: s.promo.code }, { $inc: { usedPaise: bill.discountPaise }, $push: { uses: { user: s.driver, phone: s.guestPhone, at: new Date(), discountPaise: bill.discountPaise } } });
  }
  if (s.fleet && bill.totalPaise > 0) await chargeFleet(s, bill.totalPaise);
  if (s.postpaid && s.channel === 'app' && bill.totalPaise > 0) await chargeAutopay(s, bill.totalPaise);
  // Fleet sessions are billed on the fleet's monthly invoice instead of one invoice per session.
  if (bill.totalPaise > 0 && !s.fleet) await issueSessionInvoice(s._id).catch((e) => logger.error('invoice', e));
  const after = await Session.findById(s._id);
  notify('session_completed', {
    user: s.driver, phone: s.guestPhone, session: s._id, eventAt: s.chargerTime?.endedAt || s.endedAt,
    vars: { kwh: (s.energyWh / 1000).toFixed(2), total: rupees(bill.totalPaise), refund: rupees(s.refundPaise), link: sessionLink(s) },
  }).catch(() => {});
  if (s.refundPaise > 0) notify('refund_initiated', { user: s.driver, phone: s.guestPhone, session: s._id, vars: { refund: rupees(s.refundPaise) } }).catch(() => {});
  if (s.channel === 'roaming' || s.channel === 'uei') events.emit('roaming:cdr', after);
  events.emit('session:billed', after);
  resolveAlerts({ session: s._id, type: { $in: ['stale_meter'] } }).catch(() => {});
  publish(after);
  return after;
}

async function commissionFor(s, bill) {
  if (!bill.totalPaise) return 0;
  const at = s.startedAt || s.createdAt;
  let rule = await CommissionRule.findOne({ tenant: s.tenant, effectiveFrom: { $lte: at } }).sort({ effectiveFrom: -1 }).lean();
  if (!rule) {
    const st = await getSettings();
    rule = st.defaultCommission || { kind: 'percent', value: 1000 };
  }
  if (rule.kind === 'percent') return roundPaise((bill.taxablePaise * rule.value) / 10000);
  if (rule.kind === 'per_kwh') return roundPaise((s.energyWh * rule.value) / 1000);
  return Math.min(rule.value, bill.taxablePaise);
}

async function chargeFleet(s, totalPaise) {
  const monthKey = new Date().toISOString().slice(0, 7);
  const fleet = await Fleet.findById(s.fleet);
  if (!fleet) return;
  fleet.outstandingPaise += totalPaise;
  const d = fleet.drivers.find((x) => String(x.user) === String(s.driver));
  if (d) {
    if (d.monthKey !== monthKey) {
      d.monthKey = monthKey;
      d.monthSpentPaise = 0;
    }
    d.monthSpentPaise += totalPaise;
  }
  await fleet.save();
}

/** UPI Autopay: charge the mandate after the session (mocked as an instantly captured payment). */
async function chargeAutopay(s, totalPaise) {
  const pay = await Payment.create({ tenant: s.tenant, session: s._id, provider: `${provider().name}-autopay`, orderId: `mandate_${s._id}`, amountPaise: totalPaise, paidPaise: totalPaise, status: 'captured', capturedAt: new Date(), method: 'upi_autopay', gatewayPaymentId: `pay_mandate_${s._id}` });
  await Session.updateOne({ _id: s._id }, { $set: { payment: pay._id } });
}

// ---------------------------------------------------------------- connector / charger hooks

export async function onConnectorStatus(charger, connector, status, prevStatus) {
  const active = await Session.find({ charger: charger._id, state: { $in: ['PAID', 'STARTING', 'CHARGING', 'STOPPING', 'INTERRUPTED'] } });
  for (const s of active) {
    const mine = s.connectorNumber === connector.number;
    if (s.state === 'STARTING' && mine && status === 'Occupied' && !s.pluggedAt) {
      await Session.updateOne({ _id: s._id }, { $set: { pluggedAt: new Date(), startDeadline: new Date(Date.now() + C().startTimeoutSec * 1000) } });
      publish(s._id);
    }
    if (s.state === 'STARTING' && !mine && status === 'Occupied' && charger.connector(s.connectorNumber)?.status === 'Available') {
      await Session.updateOne({ _id: s._id }, { $set: { suggestSwitchTo: connector.number } }); // STA-09
      publish(s._id);
    }
    if (mine && status === 'Faulted' && ['PAID', 'STARTING'].includes(s.state) && !s.startedAt) await failSession(s, 'connector_faulted');
    if (mine && status === 'Available' && ['CHARGING', 'STOPPING', 'INTERRUPTED'].includes(s.state) && !s.availableSince) {
      await Session.updateOne({ _id: s._id }, { $set: { availableSince: new Date() } });
    }
    if (mine && status === 'Occupied' && s.availableSince) await Session.updateOne({ _id: s._id }, { $unset: { availableSince: 1 } });
  }
  if (status === 'Faulted' && prevStatus !== 'Faulted') {
    await raiseAlert({ tenant: charger.tenant, type: 'charger_fault', severity: 'critical', charger: charger._id, message: `${charger.ocppId} connector ${connector.number} faulted${connector.errorCode ? ` (${connector.errorCode})` : ''}`, dedupeKey: `fault:${charger.ocppId}:${connector.number}` });
  } else if (prevStatus === 'Faulted' && status !== 'Faulted') {
    await resolveAlerts({ dedupeKey: `fault:${charger.ocppId}:${connector.number}` });
  }
}

/** Charger disconnected: charging continues on the charger; we mark sessions INTERRUPTED (CHG-05). */
export async function onChargerOffline(charger) {
  const sessions = await Session.find({ charger: charger._id, state: { $in: ['PAID', 'STARTING', 'CHARGING'] } });
  for (const s of sessions) {
    if (s.state === 'CHARGING') {
      const s2 = await transition(s._id, 'CHARGING', 'INTERRUPTED', { interruptedAt: new Date() }, 'charger offline');
      if (s2) notify('charger_offline', { user: s2.driver, phone: s2.guestPhone, session: s2._id, vars: { amount: rupees(s2.capPaise || 0) } }).catch(() => {});
    } else if (!s.startedAt) {
      await failSession(s, 'charger_offline'); // STA-06
    }
  }
}

export async function onChargerOnline(charger) {
  // Queued stop commands go out as soon as the charger is back (STP-05)
  const queued = await Session.find({ charger: charger._id, state: 'STOPPING', flags: 'stop_queued' });
  for (const s of queued) {
    await Session.updateOne({ _id: s._id }, { $pull: { flags: 'stop_queued' } });
    setTimeout(() => sendStop(s).catch(() => {}), 1500);
  }
}

/** Answer Authorize for app/QR session tokens, RFID cards and roaming tokens (STA-11). */
export async function authorizeToken(charger, idToken, { type } = {}) {
  if (!idToken) return 'Invalid';
  const s = await Session.findOne({ charger: charger._id, idToken, state: { $in: ['PAID', 'STARTING', 'CHARGING', 'STOPPING', 'INTERRUPTED'] } }).lean();
  if (s) return 'Accepted';
  if (type === 'eMAID' || /^[A-Z]{2}-?[A-Z0-9]{3}-?C/.test(idToken)) {
    const pnc = await User.findOne({ 'vehicles.pnc.emaid': idToken }).lean();
    if (pnc) {
      const v = pnc.vehicles.find((x) => x.pnc?.emaid === idToken);
      if (pnc.status !== 'active' || v.pnc.revokedAt) return 'Blocked';
      return pnc.fleet || pnc.autopay?.status === 'active' ? 'Accepted' : 'NoCredit';
    }
  }
  const user = await User.findOne({ 'rfidCards.uid': idToken }).lean();
  if (user) {
    const card = user.rfidCards.find((c) => c.uid === idToken);
    if (user.status !== 'active' || card.blocked) return 'Blocked';
    return user.fleet || user.autopay?.status === 'active' ? 'Accepted' : 'Invalid';
  }
  const { RoamingToken } = await import('../models/index.js');
  const t = await RoamingToken.findOne({ uid: idToken }).lean();
  if (t) return t.valid && t.whitelist !== 'NEVER' ? 'Accepted' : 'Blocked';
  return 'Invalid';
}

// ---------------------------------------------------------------- timers (run by the job loop)

export async function tickSessions() {
  const now = Date.now();
  const P = config.payments;

  // Pending payment over 5 min: poll once more, then cancel (PAY-04)
  const stale = await Session.find({ state: 'CREATED', createdAt: { $lt: new Date(now - P.pendingTimeoutSec * 1000) } }).limit(50);
  for (const s of stale) {
    const pay = s.payment ? await Payment.findById(s.payment) : null;
    if (pay?.status === 'created') {
      const st = await provider().fetchOrder(pay.orderId).catch(() => null);
      if (st?.status === 'paid') {
        await onPaymentResult({ orderId: pay.orderId, status: 'paid', gatewayPaymentId: st.paymentId, paidPaise: st.paidPaise, method: st.method });
        continue;
      }
    }
    if (pay) await Payment.updateOne({ _id: pay._id, status: { $in: ['created', 'failed', 'cancelled'] } }, { $set: { status: 'expired' } });
    await transition(s._id, 'CREATED', 'CANCELLED', { failureReason: 'payment_timeout', paymentCancelledAt: new Date() }, 'payment pending > 5 min');
  }

  // Webhook never arrived: poll gateway every 15 s up to 5 min (PAY-12)
  const pend = await Payment.find({ status: 'created', createdAt: { $gt: new Date(now - P.pendingTimeoutSec * 1000), $lt: new Date(now - P.pollEverySec * 1000) }, $or: [{ lastPolledAt: null }, { lastPolledAt: { $lt: new Date(now - P.pollEverySec * 1000) } }] }).limit(50);
  for (const pay of pend) {
    await Payment.updateOne({ _id: pay._id }, { $set: { lastPolledAt: new Date() } });
    const st = await provider().fetchOrder(pay.orderId).catch(() => null);
    if (st && st.status !== 'created') await onPaymentResult({ orderId: pay.orderId, status: st.status, gatewayPaymentId: st.paymentId, paidPaise: st.paidPaise, method: st.method, failureReason: st.failureReason });
  }

  // STARTING: plug-in window and start confirmation timeout (STA-02/04)
  const starting = await Session.find({ state: 'STARTING' }).limit(100);
  for (const s of starting) {
    if (!s.pluggedAt && s.plugDeadline && s.plugDeadline.getTime() < now) {
      // The charger's own EV connection timeout ends the pending start; a late Started is stopped (STA-05)
      await failSession(s, 'not_plugged_in');
      continue;
    }
    if (s.pluggedAt && s.startDeadline && s.startDeadline.getTime() < now) {
      if (!s.startChecked) {
        const charger = await Charger.findById(s.charger).lean();
        const r = await sendCommand(charger, 'GetTransactionStatus', s.transactionId ? { transactionId: s.transactionId } : {}, { reason: 'start timeout check', timeoutMs: 10000 });
        if (r.status === 'Accepted' && r.response?.ongoingIndicator) {
          await Session.updateOne({ _id: s._id }, { $set: { startChecked: true, startDeadline: new Date(now + 30_000) } });
          continue;
        }
      }
      await failSession(s, 'start_timeout');
    }
  }

  // CHARGING checks
  const charging = await Session.find({ state: 'CHARGING' }).limit(500);
  for (const s of charging) {
    // Car not accepting charge: no energy for 5 min -> stop + full refund (STA-08)
    if (s.energyWh <= 0 && s.startedAt && now - s.startedAt.getTime() > C().noEnergyStopSec * 1000) {
      await requestStop(s, { by: 'system', reason: 'ev_not_accepting' });
      continue;
    }
    // Zero power for 10 min: tell the driver (CHG-11)
    if (s.energyWh > 0 && s.live?.zeroPowerSince && now - s.live.zeroPowerSince.getTime() > C().zeroPowerNotifySec * 1000 && !s.alertsSent.includes('zero_power')) {
      await Session.updateOne({ _id: s._id }, { $addToSet: { alertsSent: 'zero_power' } });
      notify('zero_power', { user: s.driver, phone: s.guestPhone, session: s._id }).catch(() => {});
    }
    // No meter values: warn ops after 15 min (CHG-02)
    const lastUpdate = (s.live?.updatedAt || s.startedAt)?.getTime();
    if (lastUpdate && now - lastUpdate > 15 * 60_000) {
      await raiseAlert({ tenant: s.tenant, type: 'stale_meter', charger: s.charger, session: s._id, message: `No meter values for 15 min on ${s.ocppId}`, dedupeKey: `stale:${s._id}` });
    }
  }

  // Ended never received but connector Available for 60 s: close on last reading (STP-06)
  const avail = await Session.find({ state: { $in: ['CHARGING', 'STOPPING', 'INTERRUPTED'] }, availableSince: { $lt: new Date(now - 60_000) } }).limit(50);
  for (const s of avail) {
    await Session.updateOne({ _id: s._id }, { $set: { state: 'COMPLETED', endedAt: new Date(), stopReason: s.stopReason || 'EndedMissing' } });
    await finalizeSession(s._id, { flag: 'ended_missing' });
  }

  // Interrupted for 24 h: bill on last known reading, capped, flag for review (CHG-06)
  const lost = await Session.find({ state: 'INTERRUPTED', interruptedAt: { $lt: new Date(now - C().offlineFinaliseHours * 3600_000) } }).limit(50);
  for (const s of lost) await finalizeSession(s._id, { flag: 'offline_final' });

  // Stop not confirmed after 3 min: retry once more and alert
  const stuck = await Session.find({ state: 'STOPPING', stopRequestedAt: { $lt: new Date(now - 180_000) }, stopRetries: { $lt: 1 } }).limit(50);
  for (const s of stuck) {
    await Session.updateOne({ _id: s._id }, { $inc: { stopRetries: 1 } });
    if (s.transactionId) await sendStop(s);
  }

  // Cable stays locked after the session: UnlockConnector automatically (STP-07)
  const recent = await Session.find({ state: 'BILLED', unlockTried: false, endedAt: { $gt: new Date(now - 10 * 60_000), $lt: new Date(now - 120_000) } }).limit(50);
  for (const s of recent) {
    await Session.updateOne({ _id: s._id }, { $set: { unlockTried: true } });
    const charger = await Charger.findById(s.charger);
    const c = charger?.connector(s.connectorNumber);
    if (c && c.status === 'Occupied' && !c.activeSession && ['Finishing', undefined].includes(c.rawStatus) && s.stopReason !== 'EVDisconnected') {
      const r = await sendCommand(charger, 'UnlockConnector', { evseId: c.evseId, connectorId: c.connectorId }, { reason: `auto unlock after ${s._id}` });
      if (r.status !== 'Accepted') await raiseAlert({ tenant: s.tenant, type: 'cable_locked', charger: s.charger, session: s._id, message: `Cable may be locked on ${s.ocppId}#${s.connectorNumber}`, dedupeKey: `locked:${s._id}` });
    }
  }
}

/** Driver switches the session to the connector they actually plugged into (STA-09). */
export async function switchConnector(s, toNumber) {
  if (s.state !== 'STARTING' || s.startedAt) throw conflict('CANNOT_SWITCH', 'Charging has already started.');
  const charger = await Charger.findById(s.charger);
  const target = charger.connector(toNumber);
  if (!target || target.activeSession) throw conflict('CONNECTOR_BUSY', 'That connector is busy.');
  await releaseConnector(s);
  s.connectorNumber = target.number;
  s.evseId = target.evseId;
  s.connectorId = target.connectorId;
  s.suggestSwitchTo = undefined;
  s.state = 'PAID';
  s.history.push({ state: 'PAID', at: new Date(), note: `switched to connector ${target.number}` });
  await s.save();
  return lockAndStart(s);
}

/** Admin force-close of a stuck session with a manual final reading (Admin 3.4). */
export async function forceClose(s, { finalWh, reason }) {
  if (!['CHARGING', 'STOPPING', 'INTERRUPTED', 'STARTING', 'COMPLETED'].includes(s.state)) throw conflict('NOT_OPEN', 'Session is not open.');
  if (finalWh !== undefined && finalWh !== null) {
    const base = s.meter?.startWh ?? 0;
    if (s.meter?.startWh === undefined || s.meter?.startWh === null) s.meter = { startWh: base, lastWh: base, segmentBaseWh: 0, segmentStartWh: base, lastAt: new Date() };
    const delta = finalWh - s.meter.lastWh;
    if (delta > 0) {
      s.costs.energyExact = (s.costs.energyExact || 0) + (delta * s.tariff.energyPaisePerKwh) / 1000;
      s.meter.lastWh = finalWh;
    }
  }
  s.state = 'COMPLETED';
  s.stopReason = `force_close: ${reason}`;
  s.endedAt = new Date();
  if (!s.startedAt) s.startedAt = s.startRequestedAt || new Date();
  await s.save();
  return finalizeSession(s._id, { flag: 'force_closed' });
}
