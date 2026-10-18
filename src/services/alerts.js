import { Alert, Tenant } from '../models/index.js';
import { logger } from '../lib/logger.js';
import { events } from './events.js';
import { sendEmail, sendSms, sendWhatsapp } from './providers.js';

/**
 * Deliver a new alert to the operator's alert contacts (Requirements 7 "Alerts": email / WhatsApp).
 * Warnings go by email; critical alerts also by WhatsApp (falls back to SMS). Platform alerts go to OPS_ALERT_EMAILS.
 */
async function deliver(alert) {
  let emails = [];
  let phones = [];
  let name = 'ChargeX platform';
  if (alert.tenant) {
    const t = await Tenant.findById(alert.tenant).select('alertContacts name').lean();
    emails = t?.alertContacts?.emails || [];
    phones = t?.alertContacts?.phones || [];
    name = t?.name || name;
  } else {
    emails = (process.env.OPS_ALERT_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  const subject = `[${alert.severity.toUpperCase()}] ${name}: ${alert.type.replace(/_/g, ' ')}`;
  const sent = [];
  for (const to of emails) {
    await sendEmail(to, { subject, text: `${alert.message}\n\nOpen the console to acknowledge: Alerts.` }).then(() => sent.push(to)).catch((e) => logger.warn(`alert email ${to}: ${e.message}`));
  }
  if (alert.severity === 'critical') {
    for (const p of phones) {
      await sendWhatsapp(p, { body: `${subject} — ${alert.message}`, templateName: 'ops_alert', vars: { name, message: alert.message } })
        .catch(() => sendSms(p, { body: `${subject}: ${alert.message}`, templateId: process.env.MSG91_ALERT_FLOW_ID, vars: { message: alert.message.slice(0, 30) } }))
        .then(() => sent.push(p))
        .catch((e) => logger.warn(`alert phone: ${e.message}`));
    }
  }
  if (sent.length) await Alert.updateOne({ _id: alert._id }, { $set: { deliveredTo: sent, deliveredAt: new Date() } });
}

/**
 * Raise (or bump) an alert. Alerts with the same dedupeKey that are still open are counted, not duplicated,
 * so contacts are notified once per incident.
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
  if (severity !== 'info') deliver(alert).catch((e) => logger.warn(`alert delivery: ${e.message}`));
  return alert;
}

export async function resolveAlerts(filter, userId) {
  await Alert.updateMany({ ...filter, status: { $ne: 'resolved' } }, { $set: { status: 'resolved', resolvedBy: userId } });
}
