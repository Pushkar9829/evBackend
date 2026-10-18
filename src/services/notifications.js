import { Notification, NotificationTemplate, User } from '../models/index.js';
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

async function deliver(channel, to, body) {
  // Real providers (MSG91 DLT SMS/WhatsApp, FCM, SES) plug in here; mock logs instead.
  if (config.sms.provider === 'mock' || channel === 'push' || channel === 'email' || channel === 'inapp') {
    logger.info(`[notify:${channel}] -> ${channel === 'sms' || channel === 'whatsapp' ? maskPhone(to) : to}: ${body}`);
    return true;
  }
  throw new Error(`Provider ${config.sms.provider} not configured`);
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

  const results = [];
  for (const channel of channels) {
    const dedupeKey = session ? `${session}:${eventKey}:${channel}` : undefined;
    const tpl = channel === 'inapp' ? null : await template(eventKey, channel === 'push' ? 'push' : channel, lang);
    // DLT rule: SMS can only go out on an approved, registered template (NOT-02).
    if (channel === 'sms' && config.sms.provider !== 'mock' && !(tpl?.approved && tpl?.dltTemplateId)) {
      results.push(await safeLog({ user: u?._id, phone: to, session, channel, template: eventKey, lang, eventAt, status: 'blocked', error: 'Template not DLT-approved', dedupeKey }));
      continue;
    }
    const body = render(tpl?.body || FALLBACK_TEXT[lang]?.[eventKey] || FALLBACK_TEXT.en[eventKey] || eventKey, vars);
    try {
      await deliver(channel, channel === 'push' ? `user:${u?._id}` : to, body);
      results.push(await safeLog({ user: u?._id, phone: to, session, channel, template: eventKey, lang, body, eventAt, status: 'sent', dedupeKey }));
    } catch (e) {
      results.push(await safeLog({ user: u?._id, phone: to, session, channel, template: eventKey, lang, body, eventAt, status: 'failed', error: e.message, dedupeKey }));
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

/** Plain SMS (OTP) — goes through the same delivery/mock path. */
export async function sendOtpSms(phone, code, lang = 'en') {
  const body = render(FALLBACK_TEXT[lang]?.otp || FALLBACK_TEXT.en.otp, { code });
  await deliver('sms', phone, body);
}
