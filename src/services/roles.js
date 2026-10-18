// Loads tenant custom roles into the permissions cache so role checks stay synchronous.
import { CustomRole } from '../models/index.js';
import { cacheCustomRole, customCacheAge, roleDef } from '../lib/permissions.js';

const TTL_MS = 15_000;

/** Make sure roleDef(role) is current for a "custom:<id>" role. Fixed roles need nothing. */
export async function ensureRole(role) {
  if (!role || !String(role).startsWith('custom:')) return roleDef(role);
  const id = role.slice(7);
  if (customCacheAge(id) > TTL_MS) {
    const doc = await CustomRole.findById(id).lean().catch(() => null);
    if (doc) cacheCustomRole(doc);
  }
  return roleDef(role);
}

export async function ensureRoles(roles) {
  for (const r of roles) await ensureRole(r);
}
