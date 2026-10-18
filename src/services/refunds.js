import { Payment, Refund, Session } from '../models/index.js';
import { config } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { provider } from './payments/index.js';
import { raiseAlert } from './alerts.js';
import { notify } from './notifications.js';
import { logger } from '../lib/logger.js';
import { rupees } from '../lib/money.js';

const BACKOFF_SEC = [0, 15, 120, 600];

/**
 * Create a refund and try it immediately. The paid amount is reserved atomically, so total refunds
 * can never exceed what was paid (BIL-06), even with concurrent requests.
 */
export async function createRefund({ payment, session, amountPaise, reasonCode, reason, kind = 'auto', by, approval, processNow = true }) {
  const amt = Math.round(amountPaise);
  if (!(amt > 0)) return null;
  const pay = await Payment.findOneAndUpdate(
    { _id: payment._id || payment, status: 'captured', $expr: { $lte: [{ $add: ['$refundedPaise', amt] }, { $ifNull: ['$paidPaise', '$amountPaise'] }] } },
    { $inc: { refundedPaise: amt } },
    { new: true },
  );
  if (!pay) throw badRequest('REFUND_EXCEEDS_PAID', 'A refund cannot exceed the amount paid.');
  const refund = await Refund.create({
    tenant: pay.tenant,
    session: session?._id || session || pay.session,
    payment: pay._id,
    amountPaise: amt,
    reasonCode,
    reason,
    kind,
    initiatedBy: by,
    approval,
  });
  if (processNow) await processRefund(refund._id).catch((e) => logger.error('refund process', e));
  return Refund.findById(refund._id);
}

export async function processRefund(refundId) {
  const refund = await Refund.findOneAndUpdate(
    { _id: refundId, status: { $in: ['pending', 'failed'] }, nextAttemptAt: { $lte: new Date() } },
    { $set: { status: 'processing' }, $inc: { attempts: 1 } },
    { new: true },
  );
  if (!refund) return null;
  const pay = await Payment.findById(refund.payment);
  try {
    const r = await provider().refund(pay.gatewayPaymentId, refund.amountPaise);
    refund.status = 'succeeded';
    refund.gatewayRefundId = r.refundId;
    refund.succeededAt = new Date();
    await refund.save();
    return refund;
  } catch (e) {
    refund.lastError = e.message;
    if (refund.attempts >= config.refundMaxAttempts) {
      // After 3 failures: finance queue + driver informed (BIL-05)
      refund.status = 'finance_queue';
      await refund.save();
      await raiseAlert({ tenant: refund.tenant, type: 'refund_failure', severity: 'critical', session: refund.session, message: `Refund of Rs ${rupees(refund.amountPaise)} failed ${refund.attempts} times: ${e.message}`, dedupeKey: `refund:${refund._id}` });
      const s = await Session.findById(refund.session).lean();
      if (s) await notify('refund_delayed', { user: s.driver, phone: s.guestPhone, session: s._id, vars: { refund: rupees(refund.amountPaise) } });
    } else {
      refund.status = 'failed';
      refund.nextAttemptAt = new Date(Date.now() + (BACKOFF_SEC[refund.attempts] || 600) * 1000);
      await refund.save();
    }
    return refund;
  }
}

/** Retry job: due failed/pending refunds with backoff. */
export async function retryDueRefunds() {
  const due = await Refund.find({ status: { $in: ['pending', 'failed'] }, nextAttemptAt: { $lte: new Date() } }).limit(50).select('_id');
  for (const r of due) await processRefund(r._id);
  return due.length;
}

/** Full refund of whatever is still refundable on a payment. */
export async function refundRemaining(paymentId, opts) {
  const pay = await Payment.findById(paymentId);
  if (!pay || pay.status !== 'captured') return null;
  const remaining = (pay.paidPaise ?? pay.amountPaise) - (pay.refundedPaise || 0);
  if (remaining <= 0) return null;
  return createRefund({ payment: pay, amountPaise: remaining, ...opts });
}
