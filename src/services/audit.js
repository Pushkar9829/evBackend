import { AuditLog, SecurityEvent } from '../models/index.js';
import { logger } from '../lib/logger.js';

const clean = (v) => {
  if (v === undefined || v === null) return v;
  const o = JSON.parse(JSON.stringify(v));
  if (o && typeof o === 'object') {
    delete o.passwordHash;
    delete o.codeHash;
  }
  return o;
};

/** Record an admin action permanently. `req` supplies actor + IP when available. */
export async function audit(req, { action, entity, entityId, tenant, before, after, reason }) {
  try {
    await AuditLog.create({
      actor: req?.user?._id,
      actorName: req?.user?.name || req?.user?.email || (req ? undefined : 'system'),
      actorRole: req?.ctx?.role,
      tenant: tenant ?? req?.ctx?.tenant ?? undefined,
      action,
      entity,
      entityId: entityId ? String(entityId) : undefined,
      before: clean(before),
      after: clean(after),
      reason,
      ip: req?.ip,
    });
  } catch (e) {
    logger.error('audit write failed', e);
  }
}

export async function securityEvent(type, details = {}, ip) {
  logger.warn(`security event ${type}`, details);
  try {
    await SecurityEvent.create({ type, details, ip, tenant: details.tenant });
  } catch (e) {
    logger.error('security event write failed', e);
  }
}
