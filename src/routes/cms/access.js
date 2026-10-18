// Custom roles and API keys (Phase 3): tenants build roles from the same permission list
// and issue scoped API keys for their own systems.
import express from 'express';
import mongoose from 'mongoose';
import { ApiKey, CustomRole, User } from '../../models/index.js';
import { parse, z } from '../../lib/validate.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { randomToken, sha256 } from '../../lib/util.js';
import { API_SCOPES, ROLES, TENANT_ASSIGNABLE, TENANT_ROLES, cacheCustomRole, dropCustomRole } from '../../lib/permissions.js';
import { can, loadScoped, writeTenant } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';

const router = express.Router();

/** Role options for staff screens: fixed roles + this tenant's custom roles. */
export async function roleOptions(tenant) {
  const custom = await CustomRole.find({ tenant, archived: false }).sort({ name: 1 }).lean();
  return [
    ...TENANT_ROLES.filter((r) => r !== 'individual_host').map((r) => ({ value: r, label: r.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), custom: false })),
    ...custom.map((c) => ({ value: `custom:${c._id}`, label: c.name, custom: true })),
  ];
}

/** Throws unless `role` can be assigned on this tenant. */
export async function assertAssignable(role, tenant) {
  if (TENANT_ROLES.includes(role)) return;
  if (String(role).startsWith('custom:')) {
    const r = await CustomRole.findOne({ _id: role.slice(7), tenant, archived: false }).lean().catch(() => null);
    if (r) return;
  }
  throw badRequest('BAD_ROLE', 'Unknown role.');
}

const roleSchema = z.object({
  tenant: z.string().optional(),
  name: z.string().trim().min(2).max(60),
  description: z.string().max(300).optional(),
  perms: z.array(z.string()).min(1),
  scope: z.enum(['tenant', 'site']).default('tenant'),
  refundLimitPaise: z.number().int().min(0).max(10_000_000).default(0),
  basedOn: z.string().optional(),
});

/** No privilege escalation: you can only grant permissions you hold yourself. */
function checkPerms(req, perms) {
  const bad = perms.filter((p) => !TENANT_ASSIGNABLE.includes(p));
  if (bad.length) throw badRequest('BAD_PERMISSION', `Not assignable: ${bad.join(', ')}`);
  if (!req.isPlatform) {
    const mine = req.roleDef?.perms || [];
    const above = perms.filter((p) => !mine.includes(p));
    if (above.length) throw forbidden(`You cannot grant permissions you don't have: ${above.join(', ')}`);
  }
}

router.get('/roles', can('staff.manage'), async (req, res) => {
  const tenant = writeTenant(req, req.query.tenant);
  const custom = await CustomRole.find({ tenant }).sort({ archived: 1, name: 1 }).lean();
  const counts = await User.aggregate([{ $unwind: '$memberships' }, { $match: { 'memberships.tenant': new mongoose.Types.ObjectId(String(tenant)) } }, { $group: { _id: '$memberships.role', n: { $sum: 1 } } }]);
  res.json({
    permissions: TENANT_ASSIGNABLE,
    fixed: TENANT_ROLES.filter((r) => r !== 'individual_host').map((r) => ({ key: r, scope: ROLES[r].scope, perms: ROLES[r].perms.filter((p) => TENANT_ASSIGNABLE.includes(p)), refundLimitPaise: ROLES[r].refundLimitPaise || 0 })),
    custom: custom.map((c) => ({ ...c, members: counts.find((x) => x._id === `custom:${c._id}`)?.n || 0 })),
  });
});

router.post('/roles', can('staff.manage'), async (req, res) => {
  const b = parse(roleSchema, req.body);
  const tenant = writeTenant(req, b.tenant);
  checkPerms(req, b.perms);
  if (await CustomRole.exists({ tenant, name: b.name })) throw conflict('ROLE_EXISTS', 'A role with this name exists.');
  const r = await CustomRole.create({ ...b, tenant, createdBy: req.user._id });
  cacheCustomRole(r.toObject());
  await audit(req, { action: 'role.create', entity: 'CustomRole', entityId: r._id, tenant, after: { name: r.name, perms: r.perms, scope: r.scope, refundLimitPaise: r.refundLimitPaise } });
  res.status(201).json({ role: r, value: `custom:${r._id}` });
});

router.patch('/roles/:id', can('staff.manage'), async (req, res) => {
  const r = await loadScoped(CustomRole, req.params.id, req);
  const b = parse(roleSchema.partial().omit({ tenant: true }), req.body);
  if (b.perms) checkPerms(req, b.perms);
  const before = { name: r.name, perms: r.perms, scope: r.scope, refundLimitPaise: r.refundLimitPaise };
  Object.assign(r, b);
  await r.save();
  cacheCustomRole(r.toObject());
  // Members pick the new permissions up on their next request (role re-checked every request).
  await audit(req, { action: 'role.update', entity: 'CustomRole', entityId: r._id, tenant: r.tenant, before, after: b });
  res.json({ role: r });
});

router.delete('/roles/:id', can('staff.manage'), async (req, res) => {
  const r = await loadScoped(CustomRole, req.params.id, req);
  const members = await User.countDocuments({ memberships: { $elemMatch: { tenant: r.tenant, role: `custom:${r._id}` } } });
  if (members) throw conflict('ROLE_IN_USE', `${members} staff member(s) still have this role. Move them to another role first.`);
  r.archived = true;
  await r.save();
  dropCustomRole(r._id);
  await audit(req, { action: 'role.archive', entity: 'CustomRole', entityId: r._id, tenant: r.tenant });
  res.json({ ok: true });
});

// ------------------------------------------------------------- API keys

router.get('/api-keys', can('staff.manage'), async (req, res) => {
  const tenant = writeTenant(req, req.query.tenant);
  const keys = await ApiKey.find({ tenant }).sort({ createdAt: -1 }).select('-hash').populate('createdBy', 'name email').lean();
  res.json({ scopes: API_SCOPES, keys });
});

router.post('/api-keys', can('staff.manage'), async (req, res) => {
  const b = parse(z.object({ tenant: z.string().optional(), name: z.string().trim().min(2).max(60), scopes: z.array(z.enum(API_SCOPES)).min(1), expiresInDays: z.number().int().min(1).max(730).optional() }), req.body);
  const tenant = writeTenant(req, b.tenant);
  if ((b.scopes.includes('finance:read') && !req.isPlatform && !req.roleDef?.perms.includes('finance.view')) || (b.scopes.includes('sessions:write') && !req.isPlatform && !req.roleDef?.perms.includes('session.remote'))) {
    throw forbidden('You cannot issue a key with more access than you have.');
  }
  const prefix = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8);
  const secret = randomToken(24);
  const key = `cx_${prefix}_${secret}`;
  const doc = await ApiKey.create({ tenant, name: b.name, prefix, hash: sha256(key), scopes: b.scopes, expiresAt: b.expiresInDays ? new Date(Date.now() + b.expiresInDays * 86400_000) : undefined, createdBy: req.user._id });
  await audit(req, { action: 'apikey.create', entity: 'ApiKey', entityId: doc._id, tenant, after: { name: doc.name, prefix, scopes: doc.scopes, expiresAt: doc.expiresAt } });
  res.status(201).json({ id: doc._id, key, prefix, note: 'Copy this key now — it is shown only once.' });
});

router.post('/api-keys/:id/revoke', can('staff.manage'), async (req, res) => {
  const k = await loadScoped(ApiKey, req.params.id, req);
  if (k.revokedAt) throw conflict('ALREADY_REVOKED', 'This key is already revoked.');
  k.revokedAt = new Date();
  await k.save();
  await audit(req, { action: 'apikey.revoke', entity: 'ApiKey', entityId: k._id, tenant: k.tenant, reason: req.body?.reason });
  res.json({ ok: true });
});

export default router;
