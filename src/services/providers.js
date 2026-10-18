// Delivery providers. Each one is used only when configured by env; otherwise messages are logged (mock).
//   SMS / WhatsApp: MSG91 (DLT flow templates)      SMS_PROVIDER=msg91, MSG91_AUTH_KEY, MSG91_SENDER, MSG91_WA_NUMBER
//   Push: Firebase Cloud Messaging HTTP v1          FCM_SERVICE_ACCOUNT (service-account JSON, raw or base64)
//   Email: any SMTP server (AWS SES SMTP works)     SMTP_URL (smtp://user:pass@host:587), EMAIL_FROM
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { logger, maskPhone } from '../lib/logger.js';

const intl = (phone) => `91${String(phone).replace(/\D/g, '').slice(-10)}`;

export const providerStatus = () => ({
  sms: config.sms.provider === 'msg91' && process.env.MSG91_AUTH_KEY ? 'msg91' : 'mock',
  whatsapp: process.env.MSG91_AUTH_KEY && process.env.MSG91_WA_NUMBER ? 'msg91' : 'mock',
  push: process.env.FCM_SERVICE_ACCOUNT ? 'fcm' : 'mock',
  email: process.env.SMTP_URL ? 'smtp' : 'mock',
});

// ------------------------------------------------------------- MSG91

async function msg91(path, body) {
  const r = await fetch(`https://control.msg91.com/api/v5/${path}`, {
    method: 'POST',
    headers: { authkey: process.env.MSG91_AUTH_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.type === 'error') throw new Error(`MSG91 ${r.status}: ${json.message || JSON.stringify(json).slice(0, 200)}`);
  return json;
}

/** DLT SMS through a MSG91 Flow. `templateId` is the MSG91 flow id linked to the DLT template. */
export async function sendSms(phone, { body, templateId, vars = {} }) {
  if (providerStatus().sms === 'mock') {
    logger.info(`[sms mock] -> ${maskPhone(phone)}: ${body}`);
    return { mock: true };
  }
  if (!templateId) throw new Error('SMS template has no MSG91 flow / DLT id');
  return msg91('flow/', { template_id: templateId, sender: process.env.MSG91_SENDER, short_url: '0', recipients: [{ mobiles: intl(phone), ...vars }] });
}

/** WhatsApp template message (approved Meta template). */
export async function sendWhatsapp(phone, { body, templateName, lang = 'en', vars = {} }) {
  if (providerStatus().whatsapp === 'mock') {
    logger.info(`[whatsapp mock] -> ${maskPhone(phone)}: ${body}`);
    return { mock: true };
  }
  if (!templateName) throw new Error('WhatsApp template name missing');
  const components = Object.fromEntries(Object.values(vars).map((v, i) => [`body_${i + 1}`, { type: 'text', value: String(v) }]));
  return msg91('whatsapp/whatsapp-outbound-message/bulk/', {
    integrated_number: process.env.MSG91_WA_NUMBER,
    content_type: 'template',
    payload: { messaging_product: 'whatsapp', type: 'template', template: { name: templateName, language: { code: lang === 'hi' ? 'hi' : 'en', policy: 'deterministic' }, to_and_components: [{ to: [intl(phone)], components }] } },
  });
}

// ------------------------------------------------------------- FCM HTTP v1

let fcmToken = null;
const b64url = (b) => Buffer.from(b).toString('base64url');

function serviceAccount() {
  const raw = process.env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    return JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString());
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT is not valid JSON');
  }
}

async function fcmAccessToken(sa) {
  if (fcmToken && fcmToken.exp > Date.now() + 60_000) return fcmToken.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${sig}` }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`FCM auth failed: ${j.error_description || j.error}`);
  fcmToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return fcmToken.token;
}

/**
 * Push to every valid device token. Returns { sent, invalidTokens } so callers can mark dead
 * tokens and fall back to SMS (NOT-01).
 */
export async function sendPush(tokens, { title = 'ChargeX', body, data = {} }) {
  const list = tokens.filter((t) => t.valid !== false).map((t) => t.token);
  if (!list.length) return { sent: 0, invalidTokens: [] };
  const sa = serviceAccount();
  if (!sa) {
    logger.info(`[push mock] -> ${list.length} device(s): ${body}`);
    return { sent: list.length, invalidTokens: [], mock: true };
  }
  const access = await fcmAccessToken(sa);
  const invalidTokens = [];
  let sent = 0;
  for (const token of list) {
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, notification: { title, body }, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])), android: { priority: 'high' } } }),
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) sent += 1;
    else {
      const j = await r.json().catch(() => ({}));
      const code = j.error?.details?.[0]?.errorCode || j.error?.status;
      if (r.status === 404 || ['UNREGISTERED', 'INVALID_ARGUMENT'].includes(code)) invalidTokens.push(token);
      else logger.warn(`FCM send failed ${r.status} ${code}`);
    }
  }
  return { sent, invalidTokens };
}

// ------------------------------------------------------------- email

let transport = null;
export async function sendEmail(to, { subject, text, attachments }) {
  if (!process.env.SMTP_URL) {
    logger.info(`[email mock] -> ${to}: ${subject}${attachments?.length ? ` (+${attachments.length} attachment)` : ''}`);
    return { mock: true };
  }
  transport ||= nodemailer.createTransport(process.env.SMTP_URL);
  return transport.sendMail({ from: process.env.EMAIL_FROM || 'ChargeX <no-reply@chargex.in>', to, subject, text, attachments });
}
