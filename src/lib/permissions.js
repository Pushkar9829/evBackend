// Permissions are individual actions grouped into fixed roles (Admin Control 3.8).
export const PERMISSIONS = [
  'tenant.manage', 'tenant.view_all', 'platform.settings', 'platform.switches', 'platform.health',
  'commission.manage', 'payout.run', 'payout.hold', 'reconciliation.view', 'adjustment.create',
  'staff.manage', 'bank.manage', 'branding.manage',
  'site.view', 'site.manage',
  'charger.view', 'charger.manage', 'charger.command', 'charger.firmware', 'charger.config', 'charger.config.critical', 'ocpp.log.view',
  'tariff.view', 'tariff.manage',
  'session.view', 'session.force_close', 'session.remote', 'session.refund', 'session.view_as_driver',
  'customer.view', 'customer.block', 'customer.pii',
  'complaint.view', 'complaint.manage',
  'finance.view', 'invoice.manage',
  'report.view', 'audit.view', 'alert.view', 'approval.decide',
  'roaming.manage', 'roaming.view', 'smart.manage', 'content.manage', 'model.manage', 'simulator.use',
  'site.revenue_share',
];

const all = PERMISSIONS;
const without = (...ex) => all.filter((p) => !ex.includes(p));

export const ROLES = {
  // Group 1: our company (platform scope)
  super_admin: { scope: 'platform', perms: all, money: true },
  platform_support: {
    scope: 'platform',
    perms: ['tenant.view_all', 'platform.health', 'site.view', 'charger.view', 'charger.command', 'ocpp.log.view', 'tariff.view', 'session.view',
      'session.refund', 'session.remote', 'session.view_as_driver', 'customer.view', 'customer.block', 'complaint.view', 'complaint.manage', 'report.view', 'alert.view', 'roaming.view', 'audit.view'],
    refundLimitPaise: 50000,
  },
  platform_finance: {
    scope: 'platform',
    perms: ['tenant.view_all', 'payout.run', 'payout.hold', 'reconciliation.view', 'adjustment.create', 'commission.manage', 'finance.view', 'invoice.manage',
      'session.view', 'report.view', 'roaming.view', 'approval.decide', 'audit.view'],
    money: true,
  },
  // Group 2: tenant scope
  tenant_owner: { scope: 'tenant', perms: without('tenant.manage', 'tenant.view_all', 'platform.settings', 'platform.switches', 'platform.health', 'commission.manage', 'payout.run', 'model.manage', 'content.manage'), money: true, refundLimitPaise: 500000 },
  operations_manager: {
    scope: 'tenant',
    perms: ['site.view', 'site.manage', 'charger.view', 'charger.manage', 'charger.command', 'charger.firmware', 'charger.config', 'ocpp.log.view', 'tariff.view', 'tariff.manage',
      'session.view', 'session.remote', 'session.force_close', 'session.refund', 'session.view_as_driver', 'customer.view', 'customer.block', 'complaint.view', 'complaint.manage',
      'report.view', 'alert.view', 'roaming.manage', 'roaming.view', 'smart.manage', 'simulator.use', 'audit.view', 'approval.decide'],
    refundLimitPaise: 200000,
  },
  technician: { scope: 'tenant', perms: ['site.view', 'charger.view', 'charger.command', 'charger.firmware', 'charger.config', 'ocpp.log.view', 'alert.view', 'simulator.use'] },
  finance: { scope: 'tenant', perms: ['finance.view', 'invoice.manage', 'report.view', 'session.view', 'reconciliation.view', 'site.view'], money: true },
  support_agent: { scope: 'tenant', perms: ['session.view', 'session.refund', 'customer.view', 'complaint.view', 'complaint.manage', 'charger.view', 'site.view', 'session.view_as_driver'], refundLimitPaise: 50000 },
  site_host: { scope: 'site', perms: ['site.view', 'charger.view', 'session.view', 'site.revenue_share', 'report.view'] },
  individual_host: { scope: 'tenant', perms: ['site.view', 'site.manage', 'charger.view', 'charger.manage', 'charger.command', 'tariff.view', 'tariff.manage', 'session.view', 'finance.view', 'report.view', 'complaint.view', 'complaint.manage', 'customer.view', 'simulator.use', 'alert.view'], money: true, refundLimitPaise: 50000 },
  fleet_manager: { scope: 'fleet', perms: [] },
};

export const TENANT_ROLES = Object.entries(ROLES).filter(([, r]) => r.scope === 'tenant' || r.scope === 'site').map(([k]) => k);
export const PLATFORM_ROLES = Object.entries(ROLES).filter(([, r]) => r.scope === 'platform').map(([k]) => k);

export const roleHas = (role, perm) => !!ROLES[role]?.perms.includes(perm);
export const roleNeeds2fa = (role) => !!ROLES[role]?.money || roleHas(role, 'charger.command');
