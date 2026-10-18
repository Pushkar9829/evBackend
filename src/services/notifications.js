import { Invoice, Notification, NotificationTemplate, Session, User } from '../models/index.js';
import { sendEmail, sendPush, sendSms, sendWhatsapp } from './providers.js';
import { invoicePdfBuffer } from './invoices.js';
import { config } from '../config.js';
import { logger, maskPhone } from '../lib/logger.js';

// Events that must reach the driver even if push is off (NOT-01).
const CRITICAL = new Set(['session_started', 'session_completed', 'refund_initiated', 'refund_delayed', 'session_failed', 'otp']);
// Ordering: terminal events suppress earlier lifecycle events that arrive late (NOT-03).
const RANK = { payment_received: 1, session_started: 2, amount_80: 3, charger_offline: 3, zero_power: 3, session_completed: 5, session_failed: 5, refund_initiated: 6 };

const FALLBACK_TEXT = {
  en: {
    otp: 'Your ChargeX code is {{code}}. Valid for 5 minutes. Do not share it.',
    payment_received: 'Payment of Rs {{amount}} received. Talking to the charger...',
    session_started: 'Charging started at {{charger}}. Track it: {{link}}',
    amount_80: '80% of your Rs {{amount}} has been used.',
    session_completed: 'Charging complete: {{kwh}} kWh, Rs {{total}}. Refund Rs {{refund}}. Invoice: {{link}}',
    session_failed: "Charging didn't start. Your Rs {{amount}} is being refunded now.",
    refund_initiated: 'Refund of Rs {{refund}} initiated. Usually instant, up to 5 days for some banks.',
    charger_offline: 'We lost contact with the charger, but charging continues. You will never pay more than Rs {{amount}}.',
    zero_power: 'Your car has not taken any power for 10 minutes. It may be full.',
    refund_delayed: 'Your refund of Rs {{refund}} is taking longer than usual. Our team will contact you.',
  },
  hi: {
    otp: 'आपका ChargeX कोड {{code}} है। 5 मिनट तक मान्य। किसी से साझा न करें।',
    payment_received: 'Rs {{amount}} का भुगतान मिल गया। चार्जर से संपर्क हो रहा है...',
    session_started: '{{charger}} पर चार्जिंग शुरू। देखें: {{link}}',
    amount_80: 'आपके Rs {{amount}} का 80% उपयोग हो चुका है।',
    session_completed: 'चार्जिंग पूरी: {{kwh}} kWh, Rs {{total}}। रिफंड Rs {{refund}}। चालान: {{link}}',
    session_failed: 'चार्जिंग शुरू नहीं हुई। आपके Rs {{amount}} अभी वापस किए जा रहे हैं।',
    refund_initiated: 'Rs {{refund}} का रिफंड शुरू। आमतौर पर तुरंत, कुछ बैंकों में 5 दिन तक।',
    charger_offline: 'चार्जर से संपर्क टूटा, पर चार्जिंग जारी है। आप Rs {{amount}} से अधिक कभी नहीं देंगे।',
    zero_power: 'आपकी गाड़ी 10 मिनट से बिजली नहीं ले रही। शायद बैटरी भर गई है।',
    refund_delayed: 'आपका Rs {{refund}} का रिफंड देर से हो रहा है। हमारी टीम आपसे संपर्क करेगी।',
  },
};

const render = (body, vars) => body.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));

async function template(key, channel, lang) {
  const t = (await NotificationTemplate.findOne({ key, channel, lang }).lean()) || (await NotificationTemplate.findOne({ key, channel, lang: 'en' }).lean());
  return t;
}

const TITLES = { session_started: 'Charging started', session_completed: 'Charging complete', refund_initiated: 'Refund on its way', session_failed: "Charging didn't start", amount_80: '80% of your amount used', charger_offline: 'Charger connection lost', zero_power: 'Car not taking power' };

async function deliver(channel, { u, to, body, tpl, vars, eventKey, lang, session }) {
  if (channel === 'inapp') return;
  if (channel === 'sms') return sendSms(to, { body, templateId: tpl?.dltTemplateId, vars });
  if (channel === 'whatsapp') return sendWhatsapp(to, { body, templateName: tpl?.dltTemplateId || eventKey, lang, vars });
  if (channel === 'push') {
    const r = await sendPush(u.pushTokens || [], { title: TITLES[eventKey] || 'ChargeX', body, data: { event: eventKey, session: session ? String(session) : '' } });
    if (r.invalidTokens.length) {
      await User.updateOne({ _id: u._id }, { $set: { 'pushTokens.$[t].valid': false } }, { arrayFilters: [{ 't.token': { $in: r.invalidTokens } }] });
    }
    if (!r.sent) throw new Error('No valid push token');
    return r;
  }
  if (channel === 'email') {
    const attachments = [];
    if (eventKey === 'session_completed' && session) {
      const s = await Session.findById(session).select('invoice').lean();
      const inv = s?.invoice && (await Invoice.findById(s.invoice));
      if (inv?.status === 'issued') attachments.push({ filename: `${inv.number.replace(/\//g, '-')}.pdf`, content: await invoicePdfBuffer(inv) });
    }
    return sendEmail(u.email, { subject: TITLES[eventKey] || 'ChargeX', text: body, attachments });
  }
  throw new Error(`Unknown channel ${channel}`);
}

/**
 * Notify a driver (user or guest phone) about an event.
 * Push when possible, SMS fallback for critical events, everything mirrored as an in-app item.
 */
export async function notify(eventKey, { user, phone, session, vars = {}, eventAt = new Date() }) {
  let u = user;
  if (u && !u.notificationPrefs) u = await User.findById(u).lean();
  const lang = u?.language || 'en';
  const to = phone || u?.phone;

  if (session) {
    const later = await Notification.findOne({ session, eventAt: { $gt: eventAt } }).sort({ eventAt: -1 }).lean();
    if (later && (RANK[later.template] || 0) > (RANK[eventKey] || 0)) return { suppressed: true };
  }

  const channels = [];
  const pushOk = u?.notificationPrefs?.push !== false && u?.pushTokens?.some((t) => t.valid);
  if (pushOk) channels.push('push');
  if (!pushOk && CRITICAL.has(eventKey) && to) channels.push('sms');
  if (u) channels.push('inapp');
  if (!u && to && !channels.includes('sms') && CRITICAL.has(eventKey)) channels.push('sms');

  // Extra channels the driver opted into
  if (u?.notificationPrefs?.whatsapp && to && CRITICAL.has(eventKey) && !channels.includes('whatsapp')) channels.push('whatsapp');
  if (u?.email && u?.notificationPrefs?.email && ['session_completed', 'refund_initiated', 'refund_delayed'].includes(eventKey)) channels.push('email');

  const results = [];
  for (const channel of channels) {
    const dedupeKey = session ? `${session}:${eventKey}:${channel}` : undefined;
    const tpl = channel === 'inapp' ? null : await template(eventKey, channel, lang);
    // DLT rule: SMS can only go out on an approved, registered template (NOT-02).
    if (channel === 'sms' && config.sms.provider !== 'mock' && !(tpl?.approved && tpl?.dltTemplateId)) {
      results.push(await safeLog({ user: u?._id, phone: to, session, channel, template: eventKey, lang, eventAt, status: 'blocked', error: 'Template not DLT-approved', dedupeKey }));
      continue;
    }
    const body = render(tpl?.body || FALLBACK_TEXT[lang]?.[eventKey] || FALLBACK_TEXT.en[eventKey] || eventKey, vars);
    try {
      await deliver(channel, { u, to, body, tpl, vars, eventKey, lang, session });
      results.push(await safeLog({ user: u?._id, phone: to, session, channel, template: eventKey, lang, body, eventAt, status: 'sent', dedupeKey }));
    } catch (e) {
      results.push(await safeLog({ user: u?._id, phone: to, session, channel, template: eventKey, lang, body, eventAt, status: 'failed', error: e.message, dedupeKey }));
      // Push failed (dead tokens): critical events fall back to SMS (NOT-01)
      if (channel === 'push' && CRITICAL.has(eventKey) && to && !channels.includes('sms')) channels.push('sms');
    }
  }
  return results;
}

async function safeLog(doc) {
  try {
    return await Notification.create(doc);
  } catch (e) {
    if (e.code === 11000) return { duplicate: true };
    throw e;
  }
}

/** OTP by SMS (default), WhatsApp or voice fallback (ACC-05). */
export async function sendOtpSms(phone, code, lang = 'en', channel = 'sms') {
  const body = render(FALLBACK_TEXT[lang]?.otp || FALLBACK_TEXT.en.otp, { code });
  const tpl = await template('otp', channel === 'voice' ? 'sms' : channel, lang);
  if (channel === 'whatsapp') return sendWhatsapp(phone, { body, templateName: tpl?.dltTemplateId || 'otp', lang, vars: { code } });
  if (channel === 'voice') {
    // MSG91 voice OTP needs a separate product; logged until configured.
    logger.info(`[otp voice] -> ${maskPhone(phone)} (configure a voice provider)`);
    return { mock: true };
  }
  return sendSms(phone, { body, templateId: tpl?.dltTemplateId, vars: { code } });
}
