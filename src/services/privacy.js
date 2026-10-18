// Personal data export and deletion. Invoices are kept for the legal tax period with the
// person's name and phone removed; sessions keep energy/money figures but lose identity.
import { Complaint, DataRequest, Invoice, Notification, OtpState, Session, User } from '../models/index.js';
import { conflict } from '../lib/errors.js';
import { maskPhone } from '../lib/logger.js';

export const DATA_REQUEST_DAYS = 30;

export async function exportData({ userId, phone }) {
  const user = userId ? await User.findById(userId).lean() : null;
  const p = phone || user?.phone;
  const sessionFilter = { $or: [...(user ? [{ driver: user._id }] : []), ...(p ? [{ guestPhone: p }] : [])] };
  const sessions = sessionFilter.$or.length ? await Session.find(sessionFilter).select('ocppId connectorNumber state createdAt startedAt endedAt energyWh prepaidPaise costs refundPaise channel').lean() : [];
  const invoices = await Invoice.find({ session: { $in: sessions.map((s) => s._id) } }).select('number issuedAt totalPaise gstPaise buyer kind').lean();
  const complaints = await Complaint.find({ $or: [...(user ? [{ driver: user._id }] : []), ...(p ? [{ phone: p }] : [])] }).select('category description status createdAt resolution').lean();
  return {
    generatedAt: new Date().toISOString(),
    profile: user ? { name: user.name, phone: user.phone, email: user.email, language: user.language, gstin: user.gstin, businessName: user.businessName, vehicles: user.vehicles, notificationPrefs: user.notificationPrefs, createdAt: user.createdAt } : { phone: p },
    sessions,
    invoices,
    complaints,
  };
}

async function activeSession(filter) {
  return Session.exists({ ...filter, state: { $in: ['PAID', 'STARTING', 'CHARGING', 'STOPPING', 'INTERRUPTED'] } });
}

/** Anonymise a registered driver. Returns counts for the request record. */
export async function anonymiseUser(user) {
  if (await activeSession({ driver: user._id })) throw conflict('ACTIVE_SESSION', 'Finish the active charging session first.');
  const phone = user.phone;
  const sessions = await Session.updateMany({ driver: user._id }, { $unset: { guestPhone: 1, rating: 1 } });
  const inv = await Invoice.updateMany({ session: { $in: (await Session.find({ driver: user._id }).select('_id').lean()).map((s) => s._id) } }, { $set: { 'buyer.name': 'Deleted user', 'buyer.phone': null, 'buyer.email': null } });
  await Complaint.updateMany({ driver: user._id }, { $set: { phone: null, description: '[deleted]' } });
  await Notification.deleteMany({ user: user._id });
  if (phone) await OtpState.deleteMany({ phone });
  user.set({ phone: undefined, email: undefined, name: 'Deleted user', vehicles: [], favourites: [], savedMethods: [], pushTokens: [], rfidCards: [], gstin: undefined, businessName: undefined, status: 'deleted', deletedAt: new Date(), sessionVersion: (user.sessionVersion || 0) + 1 });
  await user.save();
  return { sessions: sessions.modifiedCount, invoices: inv.modifiedCount, phone: maskPhone(phone) };
}

/** Anonymise a guest's phone number across sessions, invoices and complaints. */
export async function anonymiseGuest(phone) {
  if (await activeSession({ guestPhone: phone })) throw conflict('ACTIVE_SESSION', 'Finish the active charging session first.');
  const ids = (await Session.find({ guestPhone: phone }).select('_id').lean()).map((s) => s._id);
  await Invoice.updateMany({ session: { $in: ids } }, { $set: { 'buyer.phone': null, 'buyer.name': 'Guest driver' } });
  const sessions = await Session.updateMany({ guestPhone: phone }, { $unset: { guestPhone: 1, rating: 1 } });
  await Complaint.updateMany({ phone }, { $set: { phone: null, description: '[deleted]' } });
  await Notification.deleteMany({ phone });
  await OtpState.deleteMany({ phone });
  return { sessions: sessions.modifiedCount, phone: maskPhone(phone) };
}

export async function openRequest({ user, phone, kind, source, reason }) {
  const existing = await DataRequest.findOne({ ...(user ? { user: user._id } : { phone }), kind, status: { $in: ['received', 'in_progress'] } });
  if (existing) return existing;
  return DataRequest.create({
    user: user?._id, phone: user ? undefined : phone, kind, source, reason,
    dueAt: new Date(Date.now() + DATA_REQUEST_DAYS * 86400_000),
    history: [{ status: 'received', at: new Date(), note: source }],
  });
}
