import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { Tenant, User, Session } from '../models/index.js';
import { config, isTest } from '../config.js';
import { parse, phoneSchema, z } from '../lib/validate.js';
import { AppError, badRequest, unauthorized } from '../lib/errors.js';
import { roleDef, roleNeeds2fa } from '../lib/permissions.js';
import { ensureRoles } from '../services/roles.js';
import { requestOtp, verifyOtp } from '../services/otp.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { getSettings } from '../services/settings.js';
import { audit, securityEvent } from '../services/audit.js';

const router = express.Router();

// Per-IP brute-force limit on top of the per-number OTP limits (SEC-05)
const ipLimit = rateLimit({ windowMs: 15 * 60_000, limit: isTest ? 10_000 : 30, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts from this network. Please wait a few minutes.' } } });

router.post('/otp/request', ipLimit, async (req, res) => {
  const b = parse(z.object({ phone: phoneSchema, channel: z.enum(['sms', 'whatsapp', 'voice']).default('sms'), lang: z.string().default('en') }), req.body);
  const r = await requestOtp(b.phone, 'login', { channel: b.channel, lang: b.lang });
  res.json(r);
});

router.post('/otp/verify', ipLimit, async (req, res) => {
  const b = parse(z.object({ phone: phoneSchema, code: z.string().min(4).max(8), name: z.string().max(80).optional(), lang: z.string().optional() }), req.body);
  await verifyOtp(b.phone, 'login', b.code);
  let user = await User.findOne({ phone: b.phone });
  const isNew = !user;
  if (!user) user = await User.create({ phone: b.phone, name: b.name, language: b.lang || 'en' }); // profile created on first login (ACC-01)
  if (user.status === 'blocked') {
    const s = await getSettings();
    throw new AppError(403, 'BLOCKED', `Your account is blocked. Please contact support at ${s.supportPhone}.`);
  }
  user.lastLoginAt = new Date();
  await user.save();
  // Link earlier guest sessions made with this number
  await Session.updateMany({ guestPhone: b.phone, driver: null }, { $set: { driver: user._id } });
  const token = signToken({ sub: String(user._id), kind: 'driver', sv: user.sessionVersion || 0 }, '30d');
  res.json({ token, user: user.toPublic(), isNew });
});

const staffContexts = (user) => {
  const out = [];
  if (user.platformRole) out.push({ role: user.platformRole, scope: 'platform', tenant: null });
  for (const m of user.memberships) {
    const def = roleDef(m.role);
    if (def) out.push({ role: m.role, roleName: def.custom ? def.name : undefined, scope: def.scope || 'tenant', tenant: String(m.tenant) });
  }
  return out;
};

async function issueStaff(user, ctx, mfa) {
  const s = await getSettings();
  const ttl = `${s.adminSessionTimeoutMin || 480}m`;
  return signToken({ sub: String(user._id), kind: 'staff', sv: user.sessionVersion || 0, ctx: { role: ctx.role, tenant: ctx.tenant }, mfa }, ttl);
}

router.post('/staff/login', ipLimit, async (req, res) => {
  const b = parse(z.object({ email: z.string().email(), password: z.string().min(1), tenant: z.string().optional() }), req.body);
  const user = await User.findOne({ email: b.email.toLowerCase() });
  if (!user?.passwordHash || !(await bcrypt.compare(b.password, user.passwordHash))) {
    await securityEvent('staff_login_failed', { email: b.email }, req.ip);
    throw unauthorized('Email or password is incorrect.');
  }
  if (user.status !== 'active') throw new AppError(403, 'BLOCKED', 'This account is disabled.');
  await ensureRoles(user.memberships.map((m) => m.role));
  const contexts = staffContexts(user);
  if (!contexts.length) throw new AppError(403, 'NO_ROLE', 'This account has no staff role.');
  const ctx = (b.tenant && contexts.find((c) => c.tenant === b.tenant)) || contexts[0];
  // Two-factor login for money and charger-command roles (Requirements 2, Admin 3.8)
  if (roleNeeds2fa(ctx.role) && user.twoFactorEnabled && user.phone) {
    await requestOtp(user.phone, 'admin_2fa').catch((e) => {
      if (e.status !== 429) throw e;
    });
    const challenge = signToken({ sub: String(user._id), stage: '2fa', ctx }, '10m');
    return res.json({ twoFactorRequired: true, challenge, phoneHint: `******${user.phone.slice(-4)}` });
  }
  const token = await issueStaff(user, ctx, false);
  user.lastLoginAt = new Date();
  await user.save();
  await audit({ user, ctx, ip: req.ip }, { action: 'staff.login', entity: 'User', entityId: user._id, tenant: ctx.tenant || undefined });
  return res.json({ token, ctx, contexts, user: user.toPublic() });
});

router.post('/staff/2fa', ipLimit, async (req, res) => {
  const b = parse(z.object({ challenge: z.string(), code: z.string().min(4).max(8) }), req.body);
  let p;
  try {
    p = jwt.verify(b.challenge, config.jwtSecret);
  } catch {
    throw unauthorized('Login expired. Please sign in again.');
  }
  if (p.stage !== '2fa') throw unauthorized();
  const user = await User.findById(p.sub);
  if (!user) throw unauthorized();
  await verifyOtp(user.phone, 'admin_2fa', b.code);
  const token = await issueStaff(user, p.ctx, true);
  user.lastLoginAt = new Date();
  await user.save();
  await audit({ user, ctx: p.ctx, ip: req.ip }, { action: 'staff.login', entity: 'User', entityId: user._id, tenant: p.ctx.tenant || undefined, after: { mfa: true } });
  res.json({ token, ctx: p.ctx, contexts: staffContexts(user), user: user.toPublic() });
});

router.post('/staff/switch', requireAuth, async (req, res) => {
  if (req.auth.kind !== 'staff') throw unauthorized();
  const b = parse(z.object({ tenant: z.string().nullable().optional(), role: z.string().optional() }), req.body);
  await ensureRoles(req.user.memberships.map((m) => m.role));
  const contexts = staffContexts(req.user);
  const ctx = contexts.find((c) => (b.tenant ? c.tenant === b.tenant : c.scope === 'platform') && (!b.role || c.role === b.role));
  if (!ctx) throw badRequest('NO_ACCESS', 'You do not have access to that workspace.');
  if (roleNeeds2fa(ctx.role) && req.user.twoFactorEnabled && !req.auth.mfa) throw new AppError(401, 'MFA_REQUIRED', 'Please sign in again with two-factor verification.');
  res.json({ token: await issueStaff(req.user, ctx, !!req.auth.mfa), ctx, contexts });
});

/** Host mode: a driver who is an Individual Host gets a CMS token for their one-person tenant (already OTP-verified). */
router.post('/host-session', requireAuth, async (req, res) => {
  if (req.auth.kind !== 'driver') throw unauthorized();
  const m = req.user.memberships.find((x) => x.role === 'individual_host');
  if (!m) throw badRequest('NOT_HOST', 'Host mode is not enabled on this account.');
  const ctx = { role: 'individual_host', tenant: String(m.tenant) };
  res.json({ token: await issueStaff(req.user, ctx, true), ctx, contexts: staffContexts(req.user) });
});

router.get('/me', requireAuth, async (req, res) => {
  const u = req.user.toPublic();
  if (req.auth.kind === 'staff') {
    await ensureRoles(req.user.memberships.map((m) => m.role));
    const contexts = staffContexts(req.user);
    const tenants = await Tenant.find({ _id: { $in: contexts.filter((c) => c.tenant).map((c) => c.tenant) } }).select('name type slug branding featureFlags').lean();
    const cur = tenants.find((t) => String(t._id) === String(req.ctx.tenant));
    const wl = cur && (cur.featureFlags instanceof Map ? cur.featureFlags.get('white_label') : cur.featureFlags?.white_label);
    return res.json({ kind: 'staff', branding: wl && cur.branding?.primaryColor ? { name: cur.branding.appName || cur.name, logoUrl: cur.branding.logoUrl, primaryColor: cur.branding.primaryColor, accentColor: cur.branding.accentColor } : null, user: u, ctx: req.ctx, permissions: roleDef(req.ctx.role)?.perms || [], contexts: contexts.map((c) => ({ ...c, tenantName: tenants.find((t) => String(t._id) === c.tenant)?.name })) });
  }
  return res.json({ kind: 'driver', user: u });
});

// Phone number change: OTP on the new number, history moves with the account (ACC-07)
router.post('/phone-change/request', requireAuth, async (req, res) => {
  const b = parse(z.object({ phone: phoneSchema }), req.body);
  if (await User.exists({ phone: b.phone })) throw badRequest('PHONE_IN_USE', 'This number is already registered.');
  res.json(await requestOtp(b.phone, 'change_phone', { meta: { userId: String(req.user._id) } }));
});

router.post('/phone-change/verify', requireAuth, async (req, res) => {
  const b = parse(z.object({ phone: phoneSchema, code: z.string() }), req.body);
  const r = await verifyOtp(b.phone, 'change_phone', b.code);
  if (r.meta?.userId !== String(req.user._id)) throw badRequest('OTP_MISMATCH', 'Code does not match this request.');
  const before = req.user.phone;
  req.user.phone = b.phone;
  await req.user.save();
  await audit(req, { action: 'driver.phone_change', entity: 'User', entityId: req.user._id, before: { phone: before }, after: { phone: b.phone } });
  res.json({ user: req.user.toPublic() });
});

export default router;
