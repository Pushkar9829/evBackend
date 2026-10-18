// Payouts to tenants and daily reconciliation (Requirements 5, Admin 3.5, BIL-11/12).
import { Adjustment, Payment, Payout, ReconciliationRun, Refund, Session, Tenant } from '../models/index.js';
import { gstOn } from '../lib/money.js';
import { issueCommissionInvoice } from './invoices.js';
import { raiseAlert } from './alerts.js';
import { logger } from '../lib/logger.js';

/** Refunds created after billing (complaints, admin) reduce what the tenant receives. */
async function postBillingRefunds(tenantId, sessionIds) {
  const rs = await Refund.find({ tenant: tenantId, session: { $in: sessionIds }, kind: 'admin', status: { $in: ['succeeded', 'processing', 'pending', 'failed'] } }).lean();
  return rs.reduce((s, r) => s + r.amountPaise, 0);
}

/**
 * Build a payout for one tenant: tenant share of completed sessions - post-billing refunds
 * - commission (+ GST on commission) +/- adjustments. Sessions settle after the tenant's delay (T+2..T+7).
 */
export async function buildPayout(tenantId, { until = new Date() } = {}) {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) return null;
  const cutoff = new Date(until.getTime() - (tenant.payoutDelayDays ?? 2) * 86400_000);
  const sessions = await Session.find({ tenant: tenantId, state: 'BILLED', settledInPayout: null, endedAt: { $lte: cutoff }, 'costs.totalPaise': { $gt: 0 }, channel: { $nin: ['roaming', 'uei'] } }).lean();
  const adjustments = await Adjustment.find({ tenant: tenantId, status: 'applied', payout: null }).lean();
  if (!sessions.length && !adjustments.length) return null;

  const gross = sessions.reduce((s, x) => s + x.costs.totalPaise, 0);
  const gstCollected = sessions.reduce((s, x) => s + x.costs.gstPaise, 0);
  const commission = sessions.reduce((s, x) => s + (x.commissionPaise || 0), 0);
  const gstOnCommission = gstOn(commission);
  const siteHost = sessions.reduce((s, x) => s + (x.siteHostSharePaise || 0), 0);
  const refunds = await postBillingRefunds(tenantId, sessions.map((s) => s._id));
  const adj = adjustments.reduce((s, a) => s + a.amountPaise, 0);
  const net = gross - commission - gstOnCommission - siteHost - refunds + adj;
  const times = sessions.map((s) => new Date(s.endedAt).getTime());

  const payout = await Payout.create({
    tenant: tenantId,
    periodStart: new Date(times.length ? Math.min(...times) : Date.now()),
    periodEnd: new Date(times.length ? Math.max(...times) : Date.now()),
    sessionCount: sessions.length,
    grossPaise: gross,
    gstCollectedPaise: gstCollected,
    commissionPaise: commission,
    gstOnCommissionPaise: gstOnCommission,
    siteHostSharePaise: siteHost,
    adjustmentsPaise: adj - refunds,
    netPaise: net,
    status: tenant.payoutHold ? 'held' : 'released',
    scheduledFor: new Date(),
    lines: sessions.map((s) => ({ session: s._id, totalPaise: s.costs.totalPaise, commissionPaise: s.commissionPaise || 0, tenantSharePaise: s.tenantSharePaise || 0 })),
  });
  await Session.updateMany({ _id: { $in: sessions.map((s) => s._id) } }, { $set: { settledInPayout: payout._id } });
  await Adjustment.updateMany({ _id: { $in: adjustments.map((a) => a._id) } }, { $set: { payout: payout._id, status: 'settled' } });
  if (commission > 0) {
    const inv = await issueCommissionInvoice(payout);
    payout.commissionInvoice = inv._id;
    await payout.save();
  }
  return payout;
}

/** Mock transfer (Razorpay Route transfer release in production). */
export async function executePayout(payout) {
  if (payout.status !== 'released') return payout;
  payout.status = 'paid';
  payout.paidAt = new Date();
  payout.gatewayTransferId = `trf_mock_${payout._id}`;
  await payout.save();
  return payout;
}

export async function runPayouts() {
  const tenants = await Tenant.find({ status: { $ne: 'pending_kyc' } }).select('_id');
  const out = [];
  for (const t of tenants) {
    try {
      const p = await buildPayout(t._id);
      if (p) out.push(await executePayout(p));
    } catch (e) {
      logger.error(`payout for ${t._id} failed`, e);
    }
  }
  return out;
}

/**
 * Daily reconciliation: sessions vs gateway payments vs refunds vs payouts. Mismatches raise a
 * finance alert with the list (BIL-11).
 */
export async function reconcile(day = new Date()) {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86400_000);
  const payments = await Payment.find({ status: 'captured', capturedAt: { $gte: start, $lt: end } }).lean();
  const mismatches = [];
  let paid = 0;
  let billed = 0;
  let refunded = 0;
  for (const p of payments) {
    paid += p.paidPaise ?? p.amountPaise;
    const s = await Session.findById(p.session).lean();
    const refunds = await Refund.find({ payment: p._id }).lean();
    const refundSum = refunds.reduce((a, r) => a + r.amountPaise, 0);
    refunded += refundSum;
    if (refunds.some((r) => r.status === 'finance_queue')) mismatches.push({ kind: 'refund_failed', ref: p.orderId, tenant: p.tenant, detail: 'Refund stuck in finance queue' });
    if (!s) {
      mismatches.push({ kind: 'payment_without_session', ref: p.orderId, tenant: p.tenant, detail: 'Captured payment has no session' });
      continue;
    }
    if (s.state === 'BILLED') {
      if (String(s.payment) === String(p._id)) {
        billed += s.costs.totalPaise;
        const expected = s.costs.totalPaise + refundSum;
        if (expected !== (p.paidPaise ?? p.amountPaise) && !s.postpaid) {
          mismatches.push({ kind: 'amount', ref: p.orderId, tenant: p.tenant, detail: `paid ${p.paidPaise} != billed ${s.costs.totalPaise} + refunds ${refundSum}` });
        }
      } else if (refundSum !== (p.paidPaise ?? p.amountPaise)) {
        mismatches.push({ kind: 'duplicate_unrefunded', ref: p.orderId, tenant: p.tenant, detail: 'Extra payment for a session was not fully refunded' });
      }
    } else if (['FAILED', 'CANCELLED'].includes(s.state)) {
      if (refundSum !== (p.paidPaise ?? p.amountPaise)) mismatches.push({ kind: 'failed_not_refunded', ref: p.orderId, tenant: p.tenant, detail: `session ${s.state} but refunds ${refundSum}/${p.paidPaise}` });
    } else if (Date.now() - new Date(p.capturedAt).getTime() > 26 * 3600_000) {
      mismatches.push({ kind: 'session_open', ref: p.orderId, tenant: p.tenant, detail: `session still ${s.state}` });
    }
  }
  const run = await ReconciliationRun.create({
    date: start.toISOString().slice(0, 10),
    totals: { payments: payments.length, paidPaise: paid, billedPaise: billed, refundedPaise: refunded },
    mismatches,
    status: mismatches.length ? 'mismatch' : 'ok',
  });
  if (mismatches.length) {
    await raiseAlert({ type: 'reconciliation', severity: 'critical', message: `Reconciliation ${run.date}: ${mismatches.length} mismatch(es)`, data: { runId: run._id }, dedupeKey: `recon:${run.date}` });
  }
  return run;
}
