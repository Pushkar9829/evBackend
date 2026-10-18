import { Alert, Tenant } from '../models/index.js';
import { logger } from '../lib/logger.js';
import { events } from './events.js';

/**
 * Raise (or bump) an alert. Alerts with the same dedupeKey that are still open are counted, not duplicated.
 * Email/WhatsApp delivery to tenant alert contacts is mocked through the logger.
 */
export async function raiseAlert({ tenant, type, severity = 'warning', charger, session, message, data, dedupeKey }) {
  const key = dedupeKey || `${type}:${charger || ''}:${session || ''}`;
  const existing = await Alert.findOneAndUpdate(
    { dedupeKey: key, status: { $ne: 'resolved' } },
    { $inc: { count: 1 }, $set: { lastAt: new Date(), message } },
    { new: true },
  );
  if (existing) return existing;
  const alert = await Alert.create({ tenant, type, severity, charger, session, message, data, dedupeKey: key });
  events.emit('alert', alert);
  if (tenant && severity !== 'info') {
    const t = await Tenant.findById(tenant).select('alertContacts name').lean();
    const to = [...(t?.alertContacts?.emails || []), ...(t?.alertContacts?.phones || [])];
    if (to.length) logger.info(`[alert-delivery mock] to ${to.join(', ')}: ${message}`);
  }
  return alert;
}

export async function resolveAlerts(filter, userId) {
  await Alert.updateMany({ ...filter, status: { $ne: 'resolved' } }, { $set: { status: 'resolved', resolvedBy: userId } });
}
