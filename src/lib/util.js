import crypto from 'node:crypto';

export const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString('hex');
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const hmac = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');
export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => new Date();
export const secondsSince = (d) => (d ? (Date.now() - new Date(d).getTime()) / 1000 : Infinity);

/** Indian financial year label for a date, e.g. "2026-27". */
export function financialYear(date = new Date()) {
  const y = date.getFullYear();
  const start = date.getMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
