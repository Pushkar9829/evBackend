// Minimal logger that masks phone numbers and payment identifiers (SEC-09).
const PHONE = /(\+?91[- ]?)?([6-9]\d{1})\d{6}(\d{2})/g;
const CARD = /\b(\d{4})\d{8,11}(\d{4})\b/g;

export function mask(value) {
  if (value === undefined || value === null) return value;
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  s = s.replace(CARD, '$1********$2').replace(PHONE, (m, cc = '', a, b) => `${cc}${a}******${b}`);
  return s;
}

export function maskPhone(phone) {
  if (!phone) return phone;
  const p = String(phone);
  return p.length >= 6 ? `${p.slice(0, 2)}******${p.slice(-2)}` : '******';
}

const silent = process.env.NODE_ENV === 'test' && !process.env.LOG_IN_TESTS;
const out = (level, args) => {
  if (silent && level !== 'error') return;
  const line = args.map((a) => (a instanceof Error ? a.stack : mask(a))).join(' ');
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(`[${new Date().toISOString()}] ${level.toUpperCase()} ${line}`);
};

export const logger = {
  info: (...a) => out('info', a),
  warn: (...a) => out('warn', a),
  error: (...a) => out('error', a),
  debug: (...a) => process.env.DEBUG && out('debug', a),
};
