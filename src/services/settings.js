import { PlatformSettings, Tenant } from '../models/index.js';

let cache = null;
let cachedAt = 0;

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < 3000) return cache;
  let s = await PlatformSettings.findOne({ key: 'platform' });
  if (!s) s = await PlatformSettings.create({ key: 'platform' });
  cache = s;
  cachedAt = Date.now();
  return s;
}

export function invalidateSettings() {
  cache = null;
}

export async function updateSettings(patch) {
  const s = await PlatformSettings.findOneAndUpdate({ key: 'platform' }, { $set: patch }, { new: true, upsert: true });
  invalidateSettings();
  return s;
}

/** Feature flag: tenant override first, then platform default. */
export async function flagOn(flag, tenantOrId) {
  const tenant = tenantOrId && tenantOrId.featureFlags ? tenantOrId : tenantOrId ? await Tenant.findById(tenantOrId).lean() : null;
  const tf = tenant?.featureFlags instanceof Map ? tenant.featureFlags.get(flag) : tenant?.featureFlags?.[flag];
  if (typeof tf === 'boolean') return tf;
  const s = await getSettings();
  return !!s.featureFlags?.get?.(flag);
}

/** Operator branding for driver pages, only for tenants with the paid white_label flag. */
export async function tenantBranding(t) {
  if (!t?.branding?.primaryColor || !(await flagOn('white_label', t))) return undefined;
  return { slug: t.slug, name: t.branding.appName || t.name, logoUrl: t.branding.logoUrl, primaryColor: t.branding.primaryColor, accentColor: t.branding.accentColor };
}
