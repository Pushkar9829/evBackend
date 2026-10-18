// Demo data. Usage: npm run seed            (adds missing demo data)
//                   npm run seed -- --reset (drops the ev_charging database first)
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDb } from '../src/db.js';
import { config } from '../src/config.js';
import { Charger, CommissionRule, Content, NotificationTemplate, PlatformSettings, RoamingPartner, Site, Tariff, Tenant, User } from '../src/models/index.js';
import { randomToken } from '../src/lib/util.js';

export const DEMO = {
  password: process.env.SEED_STAFF_PASSWORD || 'Demo@12345',
  chargerPassword: process.env.SEED_CHARGER_PASSWORD || 'charger-demo-pass',
  driverPhone: '9876543210',
};

const hash = (p) => bcrypt.hash(p, 8);

async function upsertUser(q, data) {
  const u = (await User.findOne(q)) || new User();
  Object.assign(u, data);
  await u.save();
  return u;
}

export async function seed({ reset = false, quiet = false } = {}) {
  const log = (...a) => !quiet && console.log(...a);
  if (reset) {
    const name = mongoose.connection.name;
    if (!/^ev_charging/.test(name)) throw new Error(`Refusing to drop database "${name}"`);
    await mongoose.connection.dropDatabase();
    // Unique indexes (idempotency keys, invoice numbers, webhook ids) must exist before any data is written.
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
    log(`dropped ${name} and rebuilt indexes`);
  }
  await PlatformSettings.updateOne({ key: 'platform' }, { $setOnInsert: { key: 'platform', featureFlags: { roaming: true, idle_fee: true, promo: true } } }, { upsert: true });

  const pw = await hash(DEMO.password);
  // Group 1: our company
  await upsertUser({ email: 'admin@chargex.in' }, { email: 'admin@chargex.in', phone: '9000000001', name: 'Asha (Super Admin)', passwordHash: pw, platformRole: 'super_admin' });
  await upsertUser({ email: 'support@chargex.in' }, { email: 'support@chargex.in', phone: '9000000011', name: 'Ravi (Platform Support)', passwordHash: pw, platformRole: 'platform_support' });
  await upsertUser({ email: 'finance@chargex.in' }, { email: 'finance@chargex.in', phone: '9000000012', name: 'Meera (Platform Finance)', passwordHash: pw, platformRole: 'platform_finance' });

  // Tenant 1: the client with OCPP 1.6J chargers + new 2.0.1 ones
  let vg = await Tenant.findOne({ slug: 'voltgrid' });
  if (!vg) {
    vg = await Tenant.create({
      name: 'VoltGrid Energy', slug: 'voltgrid', type: 'company', status: 'active', legalName: 'VoltGrid Energy Pvt Ltd', gstin: '27AABCV1234F1Z5', address: 'Baner, Pune, Maharashtra',
      kyc: { status: 'verified', pan: 'AABCV1234F', gstin: '27AABCV1234F1Z5' }, ocpiPartyId: 'VGE', invoicePrefix: 'VGE', payoutDelayDays: 2,
      contact: { name: 'Vikram', email: 'owner@voltgrid.in', phone: '9000000002' }, alertContacts: { emails: ['ops@voltgrid.in'] },
      bank: { accountName: 'VoltGrid Energy Pvt Ltd', accountNumberLast4: '4321', ifsc: 'HDFC0001234' }, featureFlags: { roaming: true, white_label: true },
      branding: { appName: 'VoltGo', primaryColor: '#2563eb', accentColor: '#f59e0b' },
    });
  }
  let gp = await Tenant.findOne({ slug: 'greenplug' });
  if (!gp) {
    gp = await Tenant.create({ name: 'GreenPlug Mobility', slug: 'greenplug', type: 'company', status: 'active', legalName: 'GreenPlug Mobility LLP', gstin: '29AAKFG5678K1Z2', address: 'Indiranagar, Bengaluru', kyc: { status: 'verified' }, ocpiPartyId: 'GPM', invoicePrefix: 'GPM', contact: { name: 'Nisha', email: 'owner@greenplug.in', phone: '9000000003' } });
  }

  const vgStaff = [
    ['owner@voltgrid.in', '9000000002', 'Vikram (Owner)', 'tenant_owner'],
    ['ops@voltgrid.in', '9000000021', 'Priya (Operations)', 'operations_manager'],
    ['tech@voltgrid.in', '9000000022', 'Arjun (Technician)', 'technician'],
    ['accounts@voltgrid.in', '9000000023', 'Kavita (Finance)', 'finance'],
    ['help@voltgrid.in', '9000000024', 'Sameer (Support)', 'support_agent'],
  ];
  for (const [email, phone, name, role] of vgStaff) {
    await upsertUser({ email }, { email, phone, name, passwordHash: pw, memberships: [{ tenant: vg._id, role }] });
  }
  await upsertUser({ email: 'owner@greenplug.in' }, { email: 'owner@greenplug.in', phone: '9000000003', name: 'Nisha (Owner)', passwordHash: pw, memberships: [{ tenant: gp._id, role: 'tenant_owner' }] });

  for (const t of [vg, gp]) {
    if (!(await CommissionRule.exists({ tenant: t._id }))) await CommissionRule.create({ tenant: t._id, kind: 'percent', value: 1000, effectiveFrom: new Date(0), note: '10% launch commission' });
  }

  // Tariffs (versioned)
  const tariff = async (tenant, key, name, data) => {
    if (await Tariff.exists({ tenant: tenant._id, key })) return;
    await Tariff.create({ tenant: tenant._id, key, name, version: 1, status: 'published', publishedAt: new Date(), activeFrom: new Date(Date.now() - 86400_000), ...data });
  };
  await tariff(vg, 'default', 'AC standard', { energyPaisePerKwh: 1800, sessionFeePaise: 1000, memberDiscountBps: 0, idle: { paisePerMin: 200, graceMin: 15, capPaise: 20000 } });
  await tariff(vg, 'dc-fast', 'DC fast', { energyPaisePerKwh: 2200, sessionFeePaise: 0, tod: [{ startHour: 18, endHour: 22, energyPaisePerKwh: 2500, label: 'Evening peak' }, { startHour: 0, endHour: 6, energyPaisePerKwh: 1900, label: 'Night' }], roamingEnergyPaisePerKwh: 2400 });
  await tariff(vg, 'two-wheeler', '2W / 3W', { energyPaisePerKwh: 1500 });
  await tariff(gp, 'default', 'Standard', { energyPaisePerKwh: 1600 });

  // Sites
  const site = async (tenant, name, data) => (await Site.findOne({ tenant: tenant._id, name })) || Site.create({ tenant: tenant._id, name, ...data });
  const baner = await site(vg, 'Baner Hub', { address: 'Survey 12, Baner Road, Pune 411045', city: 'Pune', state: 'Maharashtra', pincode: '411045', location: { lat: 18.559, lng: 73.7868 }, timings: '24x7', amenities: ['Cafe', 'Restroom', 'Wi-Fi'], howToReach: 'Ground floor parking, next to the cafe.' });
  const phoenix = await site(vg, 'Phoenix Mall Basement', { address: 'Phoenix Marketcity, Viman Nagar, Pune', city: 'Pune', state: 'Maharashtra', location: { lat: 18.5622, lng: 73.9167 }, timings: '10:00-22:00', amenities: ['Mall', 'Food court'], howToReach: 'Basement B2, pillar C14. Weak mobile signal: pay before going down.' });
  const andheri = await site(vg, 'Andheri Metro', { address: 'Near Andheri Metro Station, Mumbai', city: 'Mumbai', state: 'Maharashtra', location: { lat: 19.1197, lng: 72.8468 }, timings: '24x7', amenities: ['Metro'], howToReach: 'Gate 2 parking lot.' });
  const blr = await site(gp, 'Indiranagar 100ft Rd', { address: '100 Feet Road, Indiranagar, Bengaluru', city: 'Bengaluru', state: 'Karnataka', location: { lat: 12.9719, lng: 77.6412 }, timings: '24x7' });

  const cpw = await hash(DEMO.chargerPassword);
  const charger = async (tenant, s, ocppId, data) => {
    const existing = await Charger.findOne({ ocppId });
    if (existing) return existing;
    return Charger.create({ tenant: tenant._id, site: s._id, ocppId, passwordHash: cpw, readyForPublic: true, roamingEnabled: tenant === vg, uptime: { windowStart: new Date(Date.now() - 30 * 86400_000), onlineSeconds: 29.5 * 86400, scorePct: 98 }, ...data });
  };
  await charger(vg, baner, 'VG-PUN-001', { label: 'Baner DC 60', protocol: 'ocpp2.0.1', vendor: 'SimCo', model: 'Sim-DC', tariffKey: 'dc-fast', connectors: [{ number: 1, evseId: 1, connectorId: 1, type: 'CCS2', powerType: 'DC', maxPowerKw: 60, vehicleTypes: ['car'] }, { number: 2, evseId: 2, connectorId: 1, type: 'Type2', powerType: 'AC', maxPowerKw: 22, vehicleTypes: ['car'], tariffKey: 'default' }] });
  await charger(vg, baner, 'VG-PUN-002', { label: 'Baner AC 7', protocol: 'ocpp1.6', vendor: 'SimCo', model: 'Sim-AC', tariffKey: 'default', connectors: [{ number: 1, evseId: 1, connectorId: 1, type: 'Type2', powerType: 'AC', maxPowerKw: 7.4, vehicleTypes: ['car'] }] });
  await charger(vg, phoenix, 'VG-PUN-003', { label: 'Phoenix B2 AC', protocol: 'ocpp1.6', vendor: 'SimCo', model: 'Sim-AC', tariffKey: 'default', connectors: [{ number: 1, evseId: 1, connectorId: 1, type: 'Type2', powerType: 'AC', maxPowerKw: 7.4, vehicleTypes: ['car'] }, { number: 2, evseId: 2, connectorId: 1, type: 'Type2', powerType: 'AC', maxPowerKw: 7.4, vehicleTypes: ['car'] }] });
  await charger(vg, andheri, 'VG-MUM-001', { label: 'Andheri 2W/3W', protocol: 'ocpp2.0.1', vendor: 'SimCo', model: 'Sim-LEV', tariffKey: 'two-wheeler', connectors: [{ number: 1, evseId: 1, connectorId: 1, type: 'Bharat_AC001', powerType: 'AC', maxPowerKw: 3.3, vehicleTypes: ['2W', '3W'] }, { number: 2, evseId: 2, connectorId: 1, type: 'LEV_DC', powerType: 'DC', maxPowerKw: 6, vehicleTypes: ['2W', '3W'] }] });
  await charger(vg, andheri, 'VG-MUM-002', { label: 'Andheri DC 30', protocol: 'ocpp1.6', vendor: 'SimCo', model: 'Sim-DC', tariffKey: 'dc-fast', connectors: [{ number: 1, evseId: 1, connectorId: 1, type: 'CCS2', powerType: 'DC', maxPowerKw: 30, vehicleTypes: ['car'] }] });
  await charger(gp, blr, 'GP-BLR-001', { label: 'Indiranagar AC 22', protocol: 'ocpp2.0.1', vendor: 'SimCo', model: 'Sim-AC', tariffKey: 'default', connectors: [{ number: 1, evseId: 1, connectorId: 1, type: 'Type2', powerType: 'AC', maxPowerKw: 22, vehicleTypes: ['car'] }] });

  // Drivers
  await upsertUser({ phone: DEMO.driverPhone }, { phone: DEMO.driverPhone, name: 'Rohan', language: 'en', vehicles: [{ label: 'Nexon EV', make: 'Tata', model: 'Nexon EV', vehicleType: 'car', connectorTypes: ['CCS2', 'Type2'], batteryKwh: 40 }] });

  // Notification templates linked to DLT ids (NOT-02)
  const tpl = [
    ['otp', 'sms', 'en', 'Your ChargeX code is {{code}}. Valid for 5 minutes. Do not share it.', '1107160000000000001'],
    ['session_started', 'sms', 'en', 'Charging started at {{charger}}. Track it: {{link}}', '1107160000000000002'],
    ['session_completed', 'sms', 'en', 'Charging complete: {{kwh}} kWh, Rs {{total}}. Refund Rs {{refund}}. Invoice: {{link}}', '1107160000000000003'],
    ['refund_initiated', 'sms', 'en', 'Refund of Rs {{refund}} initiated. Usually instant, up to 5 days for some banks.', '1107160000000000004'],
    ['session_failed', 'sms', 'en', "Charging didn't start. Your Rs {{amount}} is being refunded now.", '1107160000000000005'],
    ['session_started', 'push', 'en', 'Charging started at {{charger}}', null],
    ['session_completed', 'push', 'en', 'Done: {{kwh}} kWh, Rs {{total}}. Refund Rs {{refund}}.', null],
  ];
  for (const [key, channel, lang, body, dlt] of tpl) {
    await NotificationTemplate.updateOne({ key, channel, lang }, { $setOnInsert: { key, channel, lang, body, dltTemplateId: dlt || undefined, approved: !!dlt || channel !== 'sms' } }, { upsert: true });
  }

  if (!(await Content.exists({ kind: 'faq' }))) {
    await Content.insertMany([
      { kind: 'faq', title: 'Do I need the app to charge?', body: 'No. Scan the QR code on the charger, pay by UPI, and charge. The app adds history, favourites and one-tap payments.', order: 1 },
      { kind: 'faq', title: 'What if charging does not start?', body: 'No energy delivered means no money taken. Your full amount is refunded automatically within seconds.', order: 2 },
      { kind: 'faq', title: 'Will I be charged more than I paid?', body: 'Never. Charging stops at your prepaid amount and any unused amount is refunded automatically.', order: 3 },
      { kind: 'faq', title: 'क्या मुझे ऐप चाहिए?', body: 'नहीं। चार्जर पर QR स्कैन करें, UPI से भुगतान करें और चार्ज करें।', lang: 'hi', order: 1 },
      { kind: 'terms', title: 'Terms of use', body: 'Draft terms. [Confirm with legal]', order: 1 },
    ]);
  }

  let partner = await RoamingPartner.findOne({ name: 'Demo eMSP (OCPI)' });
  if (!partner) partner = await RoamingPartner.create({ name: 'Demo eMSP (OCPI)', protocol: 'ocpi', roles: ['EMSP'], partyId: 'DEM', tokenA: randomToken(24), status: 'pending' });

  log('Seed complete.');
  log(`  Staff password (all demo staff): ${DEMO.password}`);
  log('  Super admin: admin@chargex.in | Tenant owner: owner@voltgrid.in | Ops: ops@voltgrid.in | Tech: tech@voltgrid.in');
  log(`  Driver phone: ${DEMO.driverPhone} | OTP: ${config.otp.demoCode || '(random, see server log)'}`);
  log(`  Charger password (seeded chargers): ${DEMO.chargerPassword}`);
  log(`  OCPI token A for "${partner.name}": ${partner.tokenA || '(already registered)'}`);
  return { vg, gp };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/seed.js');
if (isMain) {
  connectDb()
    .then(() => seed({ reset: process.argv.includes('--reset') }))
    .then(() => mongoose.disconnect())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
