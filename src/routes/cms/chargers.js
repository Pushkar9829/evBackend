// Sites, chargers and the OCPP command centre (Admin 3.3).
import express from 'express';
import bcrypt from 'bcryptjs';
import { Approval, Charger, CommandLog, FirmwareRollout, OcppMessage, Reservation, Session, Site, Tenant } from '../../models/index.js';
import { config } from '../../config.js';
import { parse, z } from '../../lib/validate.js';
import { AppError, badRequest, conflict, forbidden } from '../../lib/errors.js';
import { randomToken, escapeRegex } from '../../lib/util.js';
import { can, loadScoped, scope, writeTenant } from '../../middleware/auth.js';
import { audit } from '../../services/audit.js';
import { requestApproval, registerExecutor } from '../../services/approvals.js';
import { sendCommand } from '../../ocpp/commands.js';
import { createSession, requestStop } from '../../services/sessionEngine.js';
import { CONNECTOR_TYPES } from '../../models/charger.js';
import { pushLocation } from '../../roaming/ocpi/client.js';
import { flagOn } from '../../services/settings.js';
import { rootCaPem } from '../../services/pki.js';

const router = express.Router();
const CRITICAL_KEYS = new Set(['SecurityProfile', 'BasicAuthPassword', 'AuthorizationKey', 'NetworkConfigurationPriority', 'CentralSystemURL', 'NetworkProfile', 'Identity']);

// ------------------------------------------------------------- sites

router.get('/sites', can('site.view'), async (req, res) => {
  const sites = await Site.find(scope(req, { siteField: '_id' })).sort({ name: 1 }).lean();
  const counts = await Charger.aggregate([{ $match: { site: { $in: sites.map((s) => s._id) }, deletedAt: null } }, { $group: { _id: '$site', n: { $sum: 1 }, online: { $sum: { $cond: ['$online', 1, 0] } } } }]);
  res.json({ sites: sites.map((s) => ({ ...s, chargers: counts.find((c) => String(c._id) === String(s._id)) || { n: 0, online: 0 } })) });
});

const siteSchema = z.object({
  tenant: z.string().optional(),
  name: z.string().min(2).max(120),
  address: z.string().max(300).optional(),
  city: z.string().max(80).optional(),
  state: z.string().max(80).optional(),
  pincode: z.string().max(10).optional(),
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
  photos: z.array(z.string().url()).max(10).optional(),
  timings: z.string().max(60).optional(),
  amenities: z.array(z.string().max(40)).max(20).optional(),
  howToReach: z.string().max(500).optional(),
  revenueShareBps: z.number().int().min(0).max(5000).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

router.post('/sites', can('site.manage'), async (req, res) => {
  const b = parse(siteSchema, req.body);
  const site = await Site.create({ ...b, tenant: writeTenant(req, b.tenant) });
  await audit(req, { action: 'site.create', entity: 'Site', entityId: site._id, tenant: site.tenant, after: site });
  res.status(201).json({ site });
});

router.patch('/sites/:id', can('site.manage'), async (req, res) => {
  const site = await loadScoped(Site, req.params.id, req);
  const b = parse(siteSchema.partial().omit({ tenant: true }), req.body);
  const before = site.toObject();
  Object.assign(site, b);
  await site.save();
  await audit(req, { action: 'site.update', entity: 'Site', entityId: site._id, tenant: site.tenant, before, after: site });
  res.json({ site });
});

// ------------------------------------------------------------- chargers

router.get('/chargers', can('charger.view'), async (req, res) => {
  const f = { ...scope(req), deletedAt: null };
  if (req.query.site) f.site = req.query.site;
  if (req.query.status === 'online') f.online = true;
  if (req.query.status === 'offline') f.online = false;
  if (req.query.model) f.model = req.query.model;
  if (req.query.firmware) f.firmware = req.query.firmware;
  if (req.query.q) f.$or = [{ ocppId: new RegExp(escapeRegex(req.query.q), 'i') }, { label: new RegExp(escapeRegex(req.query.q), 'i') }];
  const chargers = await Charger.find(f).populate('site', 'name city').populate('tenant', 'name').sort({ ocppId: 1 }).lean();
  if (req.query.status === 'faulted') return res.json({ chargers: chargers.filter((c) => c.connectors.some((x) => x.status === 'Faulted')) });
  if (req.query.status === 'charging') return res.json({ chargers: chargers.filter((c) => c.connectors.some((x) => x.activeSession)) });
  return res.json({ chargers: chargers.map(({ passwordHash, ...c }) => c) });
});

router.get('/chargers/:id', can('charger.view'), async (req, res) => {
  const c = await loadScoped(Charger, req.params.id, req, { populate: 'site', lean: true });
  delete c.passwordHash;
  const sessions = await Session.find({ charger: c._id }).sort({ createdAt: -1 }).limit(10).select('state energyWh costs.totalPaise createdAt connectorNumber failureReason').lean();
  const commands = await CommandLog.find({ charger: c._id }).sort({ createdAt: -1 }).limit(20).populate('requestedBy', 'name email').lean();
  res.json({ charger: c, sessions, commands, ocppUrl: `${config.publicApiUrl.replace(/^http/, 'ws')}/ocpp/${encodeURIComponent(c.ocppId)}`, tlsOcppUrl: process.env.OCPP_TLS_PUBLIC_URL ? `${process.env.OCPP_TLS_PUBLIC_URL}/ocpp/${encodeURIComponent(c.ocppId)}` : null });
});

const connectorSchema = z.object({
  number: z.number().int().positive(),
  evseId: z.number().int().positive().optional(),
  connectorId: z.number().int().positive().optional(),
  type: z.enum(CONNECTOR_TYPES),
  powerType: z.enum(['AC', 'DC']),
  maxPowerKw: z.number().positive().max(500),
  vehicleTypes: z.array(z.enum(['2W', '3W', 'car', 'bus'])).default(['car']),
  tariffKey: z.string().optional(),
});

/** Onboarding step 1: Add Charger shows the server URL and a generated password. */
router.post('/chargers', can('charger.manage'), async (req, res) => {
  const b = parse(z.object({
    site: z.string(),
    ocppId: z.string().min(3).max(48).regex(/^[A-Za-z0-9._\-*]+$/, 'Use letters, digits, dot, dash, underscore'),
    label: z.string().max(80).optional(),
    protocol: z.enum(['ocpp2.0.1', 'ocpp2.1', 'ocpp1.6']).default('ocpp2.0.1'),
    vendor: z.string().max(60).optional(),
    model: z.string().max(60).optional(),
    connectors: z.array(connectorSchema).min(1).max(8),
    tariffKey: z.string().optional(),
  }), req.body);
  const site = await loadScoped(Site, b.site, req);
  if (await Charger.exists({ ocppId: b.ocppId })) throw conflict('DUPLICATE_ID', 'A charger with this ID already exists.');
  const password = randomToken(14);
  const charger = await Charger.create({
    ...b,
    tenant: site.tenant,
    site: site._id,
    passwordHash: await bcrypt.hash(password, 10),
    connectors: b.connectors.map((c) => ({ ...c, evseId: c.evseId || c.number, connectorId: c.connectorId || 1 })),
  });
  await audit(req, { action: 'charger.create', entity: 'Charger', entityId: charger._id, tenant: charger.tenant, after: { ocppId: charger.ocppId, protocol: charger.protocol } });
  res.status(201).json({
    charger: { id: charger._id, ocppId: charger.ocppId },
    setup: { serverUrl: `${config.publicApiUrl.replace(/^http/, 'ws')}/ocpp`, chargerId: charger.ocppId, password, securityProfile: 2, note: 'Shown once. Enter these in the charger settings.' },
  });
});

router.patch('/chargers/:id', can('charger.manage'), async (req, res) => {
  const c = await loadScoped(Charger, req.params.id, req);
  const b = parse(z.object({ label: z.string().max(80).optional(), tariffKey: z.string().optional(), connectors: z.array(connectorSchema).optional(), photos: z.array(z.string().url()).optional(), site: z.string().optional(), readyForPublic: z.boolean().optional() }), req.body);
  const before = { label: c.label, tariffKey: c.tariffKey, site: c.site };
  if (b.connectors) {
    b.connectors = b.connectors.map((n) => {
      const old = c.connector(n.number);
      return { ...(old?.toObject?.() || {}), ...n, evseId: n.evseId || old?.evseId || n.number, connectorId: n.connectorId || old?.connectorId || 1 };
    });
  }
  if (b.site) await loadScoped(Site, b.site, req);
  Object.assign(c, b);
  await c.save();
  await audit(req, { action: 'charger.update', entity: 'Charger', entityId: c._id, tenant: c.tenant, before, after: b });
  res.json({ charger: c });
});

router.post('/chargers/:id/rotate-password', can('charger.manage'), async (req, res) => {
  const c = await loadScoped(Charger, req.params.id, req);
  const password = randomToken(14);
  c.passwordHash = await bcrypt.hash(password, 10);
  await c.save();
  await audit(req, { action: 'charger.rotate_password', entity: 'Charger', entityId: c._id, tenant: c.tenant, reason: req.body?.reason });
  res.json({ password });
});

router.delete('/chargers/:id', can('charger.manage'), async (req, res) => {
  const c = await loadScoped(Charger, req.params.id, req);
  if (c.connectors.some((x) => x.activeSession)) throw conflict('ACTIVE_SESSION', 'A session is running on this charger.');
  c.deletedAt = new Date();
  c.roamingEnabled = false;
  await c.save();
  await audit(req, { action: 'charger.delete', entity: 'Charger', entityId: c._id, tenant: c.tenant, reason: req.body?.reason });
  pushLocation(c._id).catch(() => {});
  res.json({ ok: true });
});

router.get('/chargers/:id/messages', can('ocpp.log.view'), async (req, res) => {
  const c = await loadScoped(Charger, req.params.id, req, { lean: true });
  const f = { ocppId: c.ocppId };
  if (req.query.action) f.action = req.query.action;
  if (req.query.q) f.$or = [{ action: new RegExp(escapeRegex(req.query.q), 'i') }, { uniqueId: req.query.q }];
  const messages = await OcppMessage.find(f).sort({ at: -1 }).limit(Math.min(Number(req.query.limit || 200), 1000)).lean();
  res.json({ messages });
});

// ------------------------------------------------------------- command centre

const commandSchema = z.object({
  action: z.enum(['remote_start', 'remote_stop', 'reset', 'unlock', 'availability', 'get_config', 'set_config', 'trigger', 'firmware', 'get_log', 'local_list', 'clear_cache', 'install_root', 'renew_certificate', 'list_certificates', 'delete_certificate', 'security_profile', 'v2g_discharge', 'v2g_stop']),
  profile: z.number().int().min(2).max(3).optional(),
  kw: z.number().positive().max(350).optional(),
  minutes: z.number().int().min(1).max(600).optional(),
  certificateHashData: z.record(z.any()).optional(),
  connector: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
  reason: z.string().max(300).optional(),
  type: z.enum(['soft', 'hard']).optional(),
  operative: z.boolean().optional(),
  keys: z.array(z.string()).optional(),
  key: z.string().optional(),
  value: z.string().optional(),
  message: z.enum(['BootNotification', 'Heartbeat', 'StatusNotification', 'MeterValues', 'TransactionEvent', 'FirmwareStatusNotification', 'LogStatusNotification']).optional(),
  location: z.string().url().optional(),
  list: z.array(z.object({ idToken: z.string(), status: z.enum(['Accepted', 'Blocked', 'Expired', 'Invalid']) })).optional(),
  confirm: z.boolean().optional(),
});

const PERM = { remote_start: 'session.remote', remote_stop: 'session.remote', reset: 'charger.command', unlock: 'charger.command', availability: 'charger.command', get_config: 'charger.config', set_config: 'charger.config', trigger: 'charger.command', firmware: 'charger.firmware', get_log: 'charger.command', local_list: 'charger.command', clear_cache: 'charger.command', install_root: 'charger.config', renew_certificate: 'charger.config', list_certificates: 'charger.config', delete_certificate: 'charger.config.critical', security_profile: 'charger.config', v2g_discharge: 'smart.manage', v2g_stop: 'smart.manage' };

export async function runChargerCommand(req, charger, b) {
  const conn = b.connector ? charger.connector(b.connector) : null;
  const opts = { by: req.user?._id, reason: b.reason };
  switch (b.action) {
    case 'remote_start': {
      if (!b.reason) throw badRequest('REASON_REQUIRED', 'A reason is required.');
      // Operator session: postpaid, billed to the tenant, flagged for audit
      const { session } = await createSession({ ocppId: charger.ocppId, connectorNumber: b.connector || 1, admin: true });
      return { status: 'Accepted', sessionId: session._id };
    }
    case 'remote_stop': {
      if (!b.reason) throw badRequest('REASON_REQUIRED', 'A reason is required.');
      const s = b.sessionId ? await Session.findOne({ _id: b.sessionId, charger: charger._id }) : await Session.findOne({ charger: charger._id, connectorNumber: b.connector || 1, state: { $in: ['CHARGING', 'INTERRUPTED', 'STARTING', 'STOPPING'] } });
      if (!s) throw badRequest('NO_SESSION', 'No running session on this connector.');
      const r = await requestStop(s, { by: `staff:${req.user._id}`, reason: `admin: ${b.reason}` });
      return { status: r.ok || r.alreadyStopping ? 'Accepted' : r.queued ? 'Queued' : 'Rejected', detail: r };
    }
    case 'reset': {
      const active = await Session.exists({ charger: charger._id, state: { $in: ['CHARGING', 'STARTING', 'STOPPING'] } });
      if (active && !b.confirm) throw new AppError(409, 'SESSION_ACTIVE', 'A session is active on this charger. Resetting will interrupt it. Send confirm=true to proceed.');
      return sendCommand(charger, 'Reset', { type: b.type === 'hard' ? 'Immediate' : 'OnIdle' }, opts);
    }
    case 'unlock':
      return sendCommand(charger, 'UnlockConnector', { evseId: conn?.evseId || 1, connectorId: conn?.connectorId || 1 }, opts);
    case 'availability': {
      // Set in / out of service: hides it from the app instantly.
      const r = await sendCommand(charger, 'ChangeAvailability', { operationalStatus: b.operative === false ? 'Inoperative' : 'Operative', ...(conn ? { evse: { id: conn.evseId } } : {}) }, opts);
      if (!conn) await Charger.updateOne({ _id: charger._id }, { $set: { inService: b.operative !== false } });
      return r;
    }
    case 'get_config': {
      const keys = b.keys?.length ? b.keys : ['HeartbeatInterval', 'MeterValueSampleInterval', 'TxUpdatedInterval'];
      const r = await sendCommand(charger, 'GetVariables', { getVariableData: keys.map((k) => ({ component: { name: k.includes('.') ? k.split('.')[0] : 'OCPPCommCtrlr' }, variable: { name: k.includes('.') ? k.split('.')[1] : k } })) }, opts);
      if (r.status === 'Accepted') await Charger.updateOne({ _id: charger._id }, { $set: { 'configCache.variables': r.response?.getVariableResult, 'configCache.readAt': new Date() } });
      return r;
    }
    case 'set_config': {
      if (!b.key || b.value === undefined) throw badRequest('KEY_REQUIRED', 'key and value are required.');
      const name = b.key.includes('.') ? b.key.split('.')[1] : b.key;
      if (CRITICAL_KEYS.has(name) && !req.approvedExecution) {
        // Change needs approval for critical keys
        const a = await requestApproval(req, { type: 'critical_config', tenant: charger.tenant, payload: { chargerId: String(charger._id), key: b.key, value: b.value }, summary: `Set ${b.key} on ${charger.ocppId}`, reason: b.reason || 'config change' });
        return { status: 'PendingApproval', approvalId: a._id };
      }
      return sendCommand(charger, 'SetVariables', { setVariableData: [{ component: { name: b.key.includes('.') ? b.key.split('.')[0] : 'OCPPCommCtrlr' }, variable: { name }, attributeValue: String(b.value) }] }, opts);
    }
    case 'trigger':
      return sendCommand(charger, 'TriggerMessage', { requestedMessage: b.message || 'StatusNotification', ...(conn ? { evse: { id: conn.evseId } } : {}) }, opts);
    case 'firmware':
      if (!b.location) throw badRequest('LOCATION_REQUIRED', 'Firmware URL is required.');
      return sendCommand(charger, 'UpdateFirmware', { requestId: Date.now() % 1e9, firmware: { location: b.location, retrieveDateTime: new Date().toISOString() } }, opts);
    case 'get_log':
      return sendCommand(charger, 'GetLog', { logType: 'DiagnosticsLog', requestId: Date.now() % 1e9, log: { remoteLocation: b.location || `${config.publicApiUrl}/uploads/logs` } }, opts);
    case 'local_list': {
      const version = (charger.localAuthListVersion || 0) + 1;
      const r = await sendCommand(charger, 'SendLocalList', { versionNumber: version, updateType: 'Full', localAuthorizationList: (b.list || []).map((e) => ({ idToken: { idToken: e.idToken, type: 'ISO14443' }, idTokenInfo: { status: e.status } })) }, opts);
      if (r.status === 'Accepted') await Charger.updateOne({ _id: charger._id }, { $set: { localAuthListVersion: version } });
      return r;
    }
    // ---- Security Profile 3 / certificate management (A02-A05, M03-M05)
    case 'install_root':
      return sendCommand(charger, 'InstallCertificate', { certificateType: 'CSMSRootCertificate', certificate: await rootCaPem() }, opts);
    case 'renew_certificate':
      return sendCommand(charger, 'TriggerMessage', { requestedMessage: 'SignChargingStationCertificate' }, opts);
    case 'list_certificates': {
      const r = await sendCommand(charger, 'GetInstalledCertificateIds', { certificateType: ['CSMSRootCertificate', 'V2GRootCertificate', 'MORootCertificate', 'ManufacturerRootCertificate', 'V2GCertificateChain'] }, opts);
      if (r.status === 'Accepted') await Charger.updateOne({ _id: charger._id }, { $set: { installedCertificates: (r.response?.certificateHashDataChain || []).map((c) => ({ certificateType: c.certificateType, serial: c.certificateHashData?.serialNumber, at: new Date() })) } });
      return r;
    }
    case 'delete_certificate':
      if (!b.certificateHashData) throw badRequest('HASH_REQUIRED', 'certificateHashData is required.');
      return sendCommand(charger, 'DeleteCertificate', { certificateHashData: b.certificateHashData }, opts);
    case 'security_profile': {
      const profile = b.profile || 3;
      if (profile === 3 && !(charger.certificate?.notAfter > new Date())) throw badRequest('NO_CERTIFICATE', 'The charger needs a valid client certificate first: install the root CA, then renew the certificate.');
      if (!req.approvedExecution) {
        const a = await requestApproval(req, { type: 'security_profile', tenant: charger.tenant, payload: { chargerId: String(charger._id), profile }, summary: `Move ${charger.ocppId} to Security Profile ${profile}`, reason: b.reason || 'security upgrade' });
        return { status: 'PendingApproval', approvalId: a._id };
      }
      const r = await sendCommand(charger, 'SetVariables', { setVariableData: [{ component: { name: 'SecurityCtrlr' }, variable: { name: 'SecurityProfile' }, attributeValue: String(profile) }] }, opts);
      if (r.status === 'Accepted') await Charger.updateOne({ _id: charger._id }, { $set: { securityProfile: profile } });
      return r;
    }
    // ---- V2G discharge (OCPP 2.1 bidirectional power transfer)
    case 'v2g_discharge': {
      if (charger.protocol !== 'ocpp2.1') throw badRequest('NOT_V2G', 'Discharging needs an OCPP 2.1 charger.');
      const s = await Session.findOne({ charger: charger._id, connectorNumber: b.connector || 1, state: 'CHARGING' });
      if (!s?.transactionId) throw badRequest('NO_SESSION', 'V2G runs inside an active session.');
      if (!req.approvedExecution) {
        const a = await requestApproval(req, { type: 'v2g_discharge', tenant: charger.tenant, payload: { chargerId: String(charger._id), connector: b.connector || 1, kw: b.kw || 7, minutes: b.minutes || 30 }, summary: `Discharge ${b.kw || 7} kW for ${b.minutes || 30} min on ${charger.ocppId}`, reason: b.reason || 'grid support' });
        return { status: 'PendingApproval', approvalId: a._id };
      }
      const conn = charger.connector(b.connector || 1);
      const allow = await sendCommand(charger, 'NotifyAllowedEnergyTransfer', { transactionId: s.transactionId, allowedEnergyTransfer: [conn.powerType === 'DC' ? 'DC_BPT' : 'AC_BPT'] }, opts);
      if (allow.status !== 'Accepted') return allow;
      return sendCommand(charger, 'SetChargingProfile', {
        evseId: conn.evseId,
        chargingProfile: { id: 900, stackLevel: 1, chargingProfilePurpose: 'TxProfile', chargingProfileKind: 'Relative', transactionId: s.transactionId, chargingSchedule: [{ id: 1, chargingRateUnit: 'W', duration: (b.minutes || 30) * 60, chargingSchedulePeriod: [{ startPeriod: 0, setpoint: -Math.round((b.kw || 7) * 1000), operationMode: 'CentralSetpoint' }] }] },
      }, opts);
    }
    case 'v2g_stop':
      return sendCommand(charger, 'ClearChargingProfile', { chargingProfileId: 900 }, opts);
    case 'clear_cache':
      return sendCommand(charger, 'ClearCache', {}, opts);
    default:
      throw badRequest('UNKNOWN_ACTION', 'Unknown action.');
  }
}

registerExecutor('security_profile', async (a, req) => {
  const charger = await Charger.findById(a.payload.chargerId);
  const r = await runChargerCommand({ ...req, approvedExecution: true }, charger, { action: 'security_profile', profile: a.payload.profile, reason: a.reason });
  return { status: r.status };
});

registerExecutor('v2g_discharge', async (a, req) => {
  const charger = await Charger.findById(a.payload.chargerId);
  const r = await runChargerCommand({ ...req, approvedExecution: true }, charger, { action: 'v2g_discharge', connector: a.payload.connector, kw: a.payload.kw, minutes: a.payload.minutes, reason: a.reason });
  return { status: r.status };
});

registerExecutor('critical_config', async (a, req) => {
  const charger = await Charger.findById(a.payload.chargerId);
  const r = await runChargerCommand({ ...req, approvedExecution: true }, charger, { action: 'set_config', key: a.payload.key, value: a.payload.value, reason: a.reason });
  return { status: r.status };
});

router.post('/chargers/:id/commands', async (req, res, next) => {
  const b = parse(commandSchema, req.body);
  return can(PERM[b.action])(req, res, async (err) => {
    if (err) return next(err);
    const charger = await loadScoped(Charger, req.params.id, req);
    const r = await runChargerCommand(req, charger, b);
    await audit(req, { action: `charger.command.${b.action}`, entity: 'Charger', entityId: charger._id, tenant: charger.tenant, after: { ...b, result: r.status }, reason: b.reason });
    return res.json({ status: r.status, response: r.response, commandId: r.commandId, sessionId: r.sessionId, approvalId: r.approvalId, detail: r.detail });
  });
});

/** Bulk actions on a filtered set; every command shows its own result. */
router.post('/chargers/bulk', can('charger.command'), async (req, res) => {
  const b = parse(z.object({ filter: z.object({ model: z.string().optional(), firmware: z.string().optional(), site: z.string().optional(), ids: z.array(z.string()).optional() }), command: commandSchema }), req.body);
  if (b.command.action === 'firmware') throw badRequest('USE_ROLLOUT', 'Use a staged firmware rollout for bulk firmware updates.');
  const f = { ...scope(req), deletedAt: null };
  if (b.filter.model) f.model = b.filter.model;
  if (b.filter.firmware) f.firmware = b.filter.firmware;
  if (b.filter.site) f.site = b.filter.site;
  if (b.filter.ids) f._id = { $in: b.filter.ids };
  const chargers = await Charger.find(f);
  const results = [];
  for (const c of chargers) {
    try {
      const r = await runChargerCommand(req, c, b.command);
      results.push({ ocppId: c.ocppId, status: r.status });
    } catch (e) {
      results.push({ ocppId: c.ocppId, status: 'Error', error: e.message });
    }
  }
  await audit(req, { action: `charger.bulk.${b.command.action}`, entity: 'Charger', after: { filter: b.filter, count: chargers.length }, reason: b.command.reason });
  res.json({ results });
});

/** Staged firmware rollout with maker-checker: 1 charger, then 10%, then all. */
router.post('/firmware-rollouts', can('charger.firmware'), async (req, res) => {
  const b = parse(z.object({ tenant: z.string().optional(), filter: z.object({ model: z.string().optional(), firmware: z.string().optional(), ids: z.array(z.string()).optional() }), location: z.string().url(), version: z.string().max(40), reason: z.string().min(3) }), req.body);
  const tenant = writeTenant(req, b.tenant);
  const f = { tenant, deletedAt: null };
  if (b.filter.model) f.model = b.filter.model;
  if (b.filter.firmware) f.firmware = b.filter.firmware;
  if (b.filter.ids) f._id = { $in: b.filter.ids };
  const chargers = await Charger.find(f).select('_id').lean();
  if (!chargers.length) throw badRequest('NO_CHARGERS', 'No chargers match this filter.');
  const rollout = await FirmwareRollout.create({ tenant, filter: b.filter, location: b.location, version: b.version, chargerIds: chargers.map((c) => c._id), requestedBy: req.user._id });
  const a = await requestApproval(req, { type: 'bulk_firmware', tenant, payload: { rolloutId: String(rollout._id) }, summary: `Firmware ${b.version} to ${chargers.length} charger(s)`, reason: b.reason });
  rollout.approval = a._id;
  await rollout.save();
  res.status(201).json({ rollout, approvalId: a._id });
});

registerExecutor('bulk_firmware', async (a) => {
  await FirmwareRollout.updateOne({ _id: a.payload.rolloutId }, { $set: { stage: 'stage1' } });
  return { stage: 'stage1' };
});

router.get('/firmware-rollouts', can('charger.firmware'), async (req, res) => {
  res.json({ rollouts: await FirmwareRollout.find(scope(req, { siteField: null })).sort({ createdAt: -1 }).limit(50).lean() });
});

// ------------------------------------------------------------- roaming per charger

router.post('/chargers/:id/roaming', can('roaming.manage'), async (req, res) => {
  const c = await loadScoped(Charger, req.params.id, req);
  const b = parse(z.object({ enabled: z.boolean(), reason: z.string().optional() }), req.body);
  if (b.enabled) {
    const tenant = await Tenant.findById(c.tenant).lean();
    if (!(await flagOn('roaming', tenant))) throw forbidden('Roaming is not enabled for this company yet.');
    // Individual host chargers join roaming only after 30 days above 90% uptime.
    if (tenant.type === 'host') {
      const ageDays = (Date.now() - c.createdAt.getTime()) / 86400_000;
      if (ageDays < 30 || (c.uptime?.scorePct ?? 0) < 90) throw badRequest('NOT_ELIGIBLE', 'Host chargers need 30 days above 90% uptime before roaming.');
    }
  }
  c.roamingEnabled = b.enabled;
  c.roamingChangedAt = new Date();
  if (b.enabled) c.roamingEnabledAt = new Date();
  await c.save();
  await audit(req, { action: 'charger.roaming', entity: 'Charger', entityId: c._id, tenant: c.tenant, after: { enabled: b.enabled }, reason: b.reason });
  pushLocation(c._id).catch(() => {}); // removed from partner Locations feed promptly (ROM-05)
  res.json({ roamingEnabled: c.roamingEnabled });
});

// ------------------------------------------------------------- reservations & smart charging

router.post('/reservations', can('session.remote', 'smart.manage'), async (req, res) => {
  const b = parse(z.object({ chargerId: z.string(), connector: z.number().int().positive(), minutes: z.number().int().min(5).max(120).default(15), idToken: z.string().default('RESERVED') }), req.body);
  const c = await loadScoped(Charger, b.chargerId, req);
  const conn = c.connector(b.connector);
  if (!conn) throw badRequest('NO_CONNECTOR', 'Connector not found.');
  const reservationId = Date.now() % 2_000_000_000;
  const expiresAt = new Date(Date.now() + b.minutes * 60_000);
  const r = await sendCommand(c, 'ReserveNow', { id: reservationId, expiryDateTime: expiresAt.toISOString(), idToken: { idToken: b.idToken, type: 'Central' }, evseId: conn.evseId }, { by: req.user._id, reason: 'reservation' });
  const resv = await Reservation.create({ tenant: c.tenant, charger: c._id, connectorNumber: conn.number, reservationId, expiresAt, status: r.status === 'Accepted' ? 'active' : 'rejected' });
  if (r.status === 'Accepted') await Charger.updateOne({ _id: c._id, 'connectors.number': conn.number }, { $set: { 'connectors.$.reservedUntil': expiresAt } });
  res.json({ reservation: resv, status: r.status });
});

router.get('/reservations', can('charger.view'), async (req, res) => {
  res.json({ reservations: await Reservation.find(scope(req, { siteField: null })).sort({ createdAt: -1 }).limit(100).populate('charger', 'ocppId label').lean() });
});

router.post('/reservations/:id/cancel', can('session.remote', 'smart.manage'), async (req, res) => {
  const r = await loadScoped(Reservation, req.params.id, req);
  const c = await Charger.findById(r.charger);
  const out = await sendCommand(c, 'CancelReservation', { reservationId: r.reservationId }, { by: req.user._id });
  r.status = 'cancelled';
  await r.save();
  await Charger.updateOne({ _id: c._id, 'connectors.number': r.connectorNumber }, { $unset: { 'connectors.$.reservedUntil': 1 } });
  res.json({ status: out.status });
});

/** Site power limit -> SetChargingProfile on each charger (load management). Needs approval. */
router.post('/sites/:id/power-limit', can('smart.manage'), async (req, res) => {
  const site = await loadScoped(Site, req.params.id, req);
  const b = parse(z.object({ limitKw: z.number().positive().max(5000), reason: z.string().min(3) }), req.body);
  const a = await requestApproval(req, { type: 'power_limit', tenant: site.tenant, payload: { siteId: String(site._id), limitKw: b.limitKw }, summary: `Limit ${site.name} to ${b.limitKw} kW`, reason: b.reason });
  res.status(202).json({ approvalId: a._id, status: 'PendingApproval' });
});

registerExecutor('power_limit', async (a) => {
  const site = await Site.findById(a.payload.siteId);
  const chargers = await Charger.find({ site: site._id, deletedAt: null });
  const perCharger = a.payload.limitKw / Math.max(1, chargers.length);
  const results = [];
  for (const c of chargers) {
    const r = await sendCommand(c, 'SetChargingProfile', {
      evseId: 0,
      chargingProfile: { id: 1, stackLevel: 0, chargingProfilePurpose: 'ChargingStationMaxProfile', chargingProfileKind: 'Absolute', chargingSchedule: [{ id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: Math.round(perCharger * 1000) }] }] },
    }, { reason: `site power limit ${a.payload.limitKw} kW` });
    results.push({ ocppId: c.ocppId, status: r.status });
  }
  site.powerLimitKw = a.payload.limitKw;
  await site.save();
  return { results };
});

export default router;
