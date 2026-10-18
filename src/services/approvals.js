// Maker-checker: risky actions need a second person's approval (Admin 3.8).
import { Approval } from '../models/index.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { roleHas } from '../lib/permissions.js';
import { audit } from './audit.js';

const executors = new Map();
export const registerExecutor = (type, fn) => executors.set(type, fn);

// Approvals that only our company can decide.
const PLATFORM_TYPES = new Set(['commission', 'adjustment', 'payout_hold', 'payout_release']);

export async function requestApproval(req, { type, tenant, payload, summary, amountPaise, reason }) {
  if (!reason) throw badRequest('REASON_REQUIRED', 'A reason is required.');
  const a = await Approval.create({ tenant, type, payload, summary, amountPaise, reason, requestedBy: req.user._id, scope: PLATFORM_TYPES.has(type) ? 'platform' : 'tenant' });
  await audit(req, { action: 'approval.request', entity: 'Approval', entityId: a._id, tenant, after: { type, summary, amountPaise }, reason });
  return a;
}

export async function decideApproval(req, id, { approve, note }) {
  const a = await Approval.findById(id);
  if (!a) throw notFound();
  if (a.status !== 'pending') throw conflict('ALREADY_DECIDED', 'This request was already decided.');
  if (String(a.requestedBy) === String(req.user._id)) throw forbidden('You cannot approve your own request.');
  if (!roleHas(req.ctx.role, 'approval.decide')) throw forbidden();
  if (a.scope === 'platform' && !req.isPlatform) throw forbidden('This request must be approved by the platform team.');
  if (!req.isPlatform && String(a.tenant) !== String(req.ctx.tenant)) throw forbidden();
  a.decidedBy = req.user._id;
  a.decidedAt = new Date();
  a.decisionNote = note;
  if (!approve) {
    a.status = 'rejected';
    await a.save();
    await audit(req, { action: 'approval.reject', entity: 'Approval', entityId: a._id, tenant: a.tenant, after: { type: a.type }, reason: note });
    return a;
  }
  a.status = 'approved';
  await a.save();
  const exec = executors.get(a.type);
  try {
    a.result = exec ? await exec(a, req) : null;
    a.status = 'executed';
  } catch (e) {
    a.status = 'failed';
    a.result = { error: e.message };
  }
  await a.save();
  await audit(req, { action: 'approval.approve', entity: 'Approval', entityId: a._id, tenant: a.tenant, after: { type: a.type, status: a.status, result: a.result }, reason: note });
  return a;
}
