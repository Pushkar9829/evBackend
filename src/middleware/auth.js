import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User, Tenant } from '../models/index.js';
import { unauthorized, forbidden, AppError } from '../lib/errors.js';
import { ROLES, roleHas } from '../lib/permissions.js';
import { getSettings } from '../services/settings.js';
import { securityEvent } from '../services/audit.js';

export function signToken(payload, ttl = config.jwtTtl) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: ttl });
}

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

/** Attach req.user + req.ctx when a valid token is present; never rejects. */
export async function optionalAuth(req, _res, next) {
  try {
    const token = readToken(req);
    if (!token) return next();
    const p = jwt.verify(token, config.jwtSecret);
    if (p.stage === '2fa') return next();
    const user = await User.findById(p.sub);
    if (!user || user.status === 'deleted' || (user.sessionVersion || 0) !== (p.sv || 0)) return next();
    req.user = user;
    req.auth = p;
    req.ctx = p.ctx || null;
    return next();
  } catch {
    return next();
  }
}

export async function requireAuth(req, res, next) {
  await optionalAuth(req, res, () => {});
  if (!req.user) return next(unauthorized());
  if (req.user.status === 'blocked') {
    const s = await getSettings();
    return next(new AppError(403, 'BLOCKED', `Your account is blocked. Please contact support at ${s.supportPhone}.`));
  }
  return next();
}

export const requireDriver = requireAuth;

/** Staff (tenant or platform) with a resolved role context. */
export async function requireStaff(req, res, next) {
  await requireAuth(req, res, async (err) => {
    if (err) return next(err);
    if (req.auth.kind !== 'staff' || !req.ctx?.role) return next(forbidden('Staff login required.'));
    const s = await getSettings();
    if (s.adminIpAllowList?.length && !s.adminIpAllowList.includes(req.ip)) {
      await securityEvent('admin_ip_blocked', { user: String(req.user._id) }, req.ip);
      return next(forbidden('This network is not allowed for admin access.'));
    }
    // Re-validate the role against the database on every request (role changes apply immediately).
    const { role, tenant } = req.ctx;
    if (ROLES[role]?.scope === 'platform') {
      if (req.user.platformRole !== role) return next(unauthorized('Your role changed. Please log in again.'));
    } else {
      const m = req.user.membershipFor(tenant);
      if (!m || m.role !== role) return next(unauthorized('Your role changed. Please log in again.'));
      const t = await Tenant.findById(tenant).select('status type name').lean();
      if (!t) return next(unauthorized());
      req.tenantDoc = t;
      req.ctx.siteIds = (m.siteIds || []).map(String);
    }
    req.isPlatform = ROLES[role]?.scope === 'platform';
    return next();
  });
}

/** Permission gate. Hidden in the UI AND blocked here (SEC-07). */
export const can = (...perms) => async (req, _res, next) => {
  const role = req.ctx?.role;
  if (perms.some((p) => roleHas(role, p))) return next();
  await securityEvent('permission_denied', { user: String(req.user?._id), role, perms, path: req.originalUrl, tenant: req.ctx?.tenant }, req.ip);
  return next(forbidden());
};

/**
 * Mongo filter limiting a query to what the caller may see.
 * Platform roles: everything (optionally narrowed by ?tenant=). Tenant roles: own tenant only.
 * Site-scoped roles: own sites only.
 */
export function scope(req, { siteField = 'site', tenantField = 'tenant' } = {}) {
  if (req.isPlatform) return req.query.tenant ? { [tenantField]: req.query.tenant } : {};
  const f = { [tenantField]: req.ctx.tenant };
  if (ROLES[req.ctx.role]?.scope === 'site' && siteField) f[siteField] = { $in: req.ctx.siteIds };
  return f;
}

/** Load a document by id and enforce tenant isolation: another tenant's id gives 403 and a security event (SEC-01). */
export async function loadScoped(Model, id, req, { populate, tenantField = 'tenant', lean = false } = {}) {
  let q = Model.findById(id);
  if (populate) q = q.populate(populate);
  if (lean) q = q.lean();
  const doc = await q.catch(() => null);
  if (!doc) throw new AppError(404, 'NOT_FOUND', 'Not found.');
  if (!req.isPlatform) {
    const docTenant = String(doc[tenantField]?._id || doc[tenantField]);
    if (docTenant !== String(req.ctx.tenant)) {
      await securityEvent('cross_tenant_access', { user: String(req.user._id), tenant: req.ctx.tenant, target: String(id), model: Model.modelName }, req.ip);
      throw forbidden();
    }
    if (ROLES[req.ctx.role]?.scope === 'site' && doc.site && !req.ctx.siteIds.includes(String(doc.site?._id || doc.site))) throw forbidden();
  }
  return doc;
}

/** Tenant id a write applies to. Platform users must name the tenant explicitly. */
export function writeTenant(req, bodyTenant) {
  if (req.isPlatform) {
    if (!bodyTenant) throw new AppError(400, 'TENANT_REQUIRED', 'Choose a tenant.');
    return bodyTenant;
  }
  return req.ctx.tenant;
}
